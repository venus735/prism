/*
 ============================================================================
 Name        : hev-socks5-uid.c
 Description : Per-connection app owner lookup
 ============================================================================
 */

#include "hev-socks5-uid.h"

#ifndef ANDROID

const char *
hev_uid_lookup_app (const char *src_ip, int src_port, const char *dst_ip,
                    int dst_port)
{
    (void)src_ip;
    (void)src_port;
    (void)dst_ip;
    (void)dst_port;
    return NULL;
}

#else /* ANDROID */

#include <jni.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <hev-task.h>

/*
 * hev task 是用户态协程（自定义栈），从协程栈调 AttachCurrentThread 违反 ART
 * 线程模型（GC 扫描线程栈会撞上堆内协程栈，实测 SIGSEGV）。故 JNI 查询全部
 * 落到专职桥接线程（真实 pthread 栈），协程投递请求后 hev_task_sleep 轮询。
 */

/* 缓存于 hev-jni.c 的 JNI_OnLoad */
JavaVM *hev_jni_get_java_vm (void);
jclass hev_jni_get_tunnel_class (void);
jmethodID hev_jni_get_lookup_app_mid (void);

typedef struct _UidReq UidReq;

struct _UidReq
{
    char src_ip[46];
    int src_port;
    char dst_ip[46];
    int dst_port;
    char label[256];
    atomic_int done;
    UidReq *next;
};

static pthread_mutex_t queue_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t queue_cond = PTHREAD_COND_INITIALIZER;
static UidReq *queue_head;
static UidReq *queue_tail;
static pthread_t bridge_thread;
static int bridge_started;

static void *
bridge_thread_handler (void *data)
{
    JavaVM *vm = hev_jni_get_java_vm ();
    jclass klass = hev_jni_get_tunnel_class ();
    jmethodID mid = hev_jni_get_lookup_app_mid ();
    JNIEnv *env = NULL;

    (void)data;

    if ((*vm)->AttachCurrentThread (vm, &env, NULL) != JNI_OK)
        return NULL;

    for (;;) {
        UidReq *r;
        jstring jsip, jdip, jres = NULL;

        pthread_mutex_lock (&queue_mutex);
        while (!queue_head)
            pthread_cond_wait (&queue_cond, &queue_mutex);
        r = queue_head;
        queue_head = r->next;
        if (!queue_head)
            queue_tail = NULL;
        r->next = NULL;
        pthread_mutex_unlock (&queue_mutex);

        jsip = (*env)->NewStringUTF (env, r->src_ip);
        jdip = (*env)->NewStringUTF (env, r->dst_ip);
        if (jsip && jdip) {
            jres = (*env)->CallStaticObjectMethod (env, klass, mid, jsip,
                                                   (jint)r->src_port, jdip,
                                                   (jint)r->dst_port);
            if ((*env)->ExceptionCheck (env)) {
                (*env)->ExceptionClear (env);
                jres = NULL;
            }
        } else if ((*env)->ExceptionCheck (env)) {
            (*env)->ExceptionClear (env);
        }

        if (jres) {
            const char *bytes = (*env)->GetStringUTFChars (env, jres, NULL);
            if (bytes) {
                snprintf (r->label, sizeof (r->label), "%s", bytes);
                (*env)->ReleaseStringUTFChars (env, jres, bytes);
            }
            (*env)->DeleteLocalRef (env, jres);
        }
        if (jsip)
            (*env)->DeleteLocalRef (env, jsip);
        if (jdip)
            (*env)->DeleteLocalRef (env, jdip);

        atomic_store_explicit (&r->done, 1, memory_order_release);
    }

    return NULL;
}

static int
ensure_bridge (void)
{
    int res = 0;

    if (bridge_started)
        return 0;

    if (!hev_jni_get_java_vm () || !hev_jni_get_tunnel_class () ||
        !hev_jni_get_lookup_app_mid ())
        return -1;

    pthread_mutex_lock (&queue_mutex);
    if (!bridge_started) {
        res = pthread_create (&bridge_thread, NULL, bridge_thread_handler,
                              NULL);
        if (res == 0)
            bridge_started = 1;
    }
    pthread_mutex_unlock (&queue_mutex);

    return res;
}

const char *
hev_uid_lookup_app (const char *src_ip, int src_port, const char *dst_ip,
                    int dst_port)
{
    UidReq *r;
    char *label;
    int i;

    if (ensure_bridge () < 0)
        return NULL;

    r = calloc (1, sizeof (UidReq));
    if (!r)
        return NULL;
    snprintf (r->src_ip, sizeof (r->src_ip), "%s", src_ip);
    r->src_port = src_port;
    snprintf (r->dst_ip, sizeof (r->dst_ip), "%s", dst_ip);
    r->dst_port = dst_port;

    pthread_mutex_lock (&queue_mutex);
    if (queue_tail)
        queue_tail->next = r;
    else
        queue_head = r;
    queue_tail = r;
    pthread_cond_signal (&queue_cond);
    pthread_mutex_unlock (&queue_mutex);

    for (i = 0; i < 500; i++) {
        if (atomic_load_explicit (&r->done, memory_order_acquire))
            break;
        hev_task_sleep (1);
    }

    if (!atomic_load_explicit (&r->done, memory_order_acquire)) {
        /* 超时：能摘除则释放；已被桥接线程取走则等待其完成（毫秒级），
         * 仍不完成说明桥接线程卡死，泄漏该请求也绝不 use-after-free */
        UidReq *it, *before = NULL;
        int removed = 0;

        pthread_mutex_lock (&queue_mutex);
        for (it = queue_head; it; before = it, it = it->next) {
            if (it == r) {
                if (before)
                    before->next = r->next;
                else
                    queue_head = r->next;
                if (queue_tail == r)
                    queue_tail = before;
                removed = 1;
                break;
            }
        }
        pthread_mutex_unlock (&queue_mutex);

        if (removed) {
            free (r);
            return NULL;
        }
        for (i = 0; i < 1000; i++) {
            if (atomic_load_explicit (&r->done, memory_order_acquire))
                break;
            hev_task_sleep (1);
        }
        if (!atomic_load_explicit (&r->done, memory_order_acquire))
            return NULL;
    }

    if (r->label[0] == '\0') {
        free (r);
        return NULL;
    }

    label = strdup (r->label);
    free (r);
    return label;
}

#endif /* ANDROID */

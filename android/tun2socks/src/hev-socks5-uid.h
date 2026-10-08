/*
 ============================================================================
 Name        : hev-socks5-uid.h
 Description : Per-connection app owner lookup (Android)
 ============================================================================
 */

#ifndef __HEV_SOCKS5_UID_H__
#define __HEV_SOCKS5_UID_H__

#ifdef __cplusplus
extern "C" {
#endif

/*
 * 查询发起该连接的本机应用名（Android 经 JNI 调 TunnelVpnService.lookupAppOwner）。
 * 返回 malloc 分配的字符串（调用方负责 free），查询失败返回 NULL。
 */
const char *hev_uid_lookup_app (const char *src_ip, int src_port,
                                const char *dst_ip, int dst_port);

#ifdef __cplusplus
}
#endif

#endif /* __HEV_SOCKS5_UID_H__ */

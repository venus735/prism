export const JS_TEMPLATE = `// JS 插件运行在代理主进程（Node.js），保存后自动热重载。
//
// onRequest(ctx)  请求转发上游前调用
//   ctx: { flowId, method, url, headers: [{name, value}], bodyBase64, log }
//   返回 { request: { method?, url?, headers?, bodyBase64? } }  修改后继续转发
//   返回 { respond: { status, statusText?, headers, bodyBase64 } }  直接返回，不打上游
//
// onResponse(ctx)  收到上游响应后调用
//   ctx 额外包含 status, statusText, respHeaders, respBodyBase64
//   返回 { response: { status?, statusText?, headers?, bodyBase64? } }  修改后返回客户端
//
// 抛错 3 次插件会被自动禁用（可在插件页重新启用）。

export async function onRequest(ctx) {
  // 只处理感兴趣的请求（按 url 判断），其他直接放行
  if (!ctx.url.includes('/echo')) return

  const body = Buffer.from(ctx.bodyBase64, 'base64').toString('utf8')
  ctx.log('onRequest ' + ctx.method + ' ' + ctx.url + ' body=' + body.slice(0, 100))

  // 示例：改写请求体（把这里换成你的加密/解密逻辑）
  return {
    request: {
      bodyBase64: Buffer.from(body + '-by-js-plugin').toString('base64')
    }
  }
}

export async function onResponse(ctx) {
  const body = Buffer.from(ctx.respBodyBase64, 'base64').toString('utf8')

  // 示例：解密响应体后替换
  // const decrypted = myDecrypt(body)
  // return { response: { bodyBase64: Buffer.from(decrypted).toString('base64') } }
}
`

export const PYTHON_TEMPLATE = `# Python 插件：每个插件一个常驻 python3 子进程（NDJSON-RPC over stdio）。
# 修改 plugin.py 后需要点击插件页的「重新扫描」。
#
# onRequest(ctx) / onResponse(ctx) 与 JS 插件签名一致：
#   ctx: { flowId, method, url, headers, bodyBase64, log, ... }
#   onResponse 额外包含 status, statusText, respHeaders, respBodyBase64
# 返回值与 JS 插件相同：{ request: {...} } / { respond: {...} } / { response: {...} }
# body 超过 2MB 时插件会被跳过；抛错 3 次自动禁用。

import base64


def decrypt(text):
    """替换为你的解密逻辑"""
    return text


def encrypt(text):
    """替换为你的加密逻辑"""
    return text


def onRequest(ctx):
    if "/echo" not in ctx["url"]:
        return None

    body = base64.b64decode(ctx["bodyBase64"]).decode("utf-8")
    ctx["log"]("onRequest %s %s" % (ctx["method"], ctx["url"]))

    # 示例：改写请求体
    return {
        "request": {
            "bodyBase64": base64.b64encode((body + "-by-python-plugin").encode()).decode()
        }
    }


def onResponse(ctx):
    body = base64.b64decode(ctx["respBodyBase64"]).decode("utf-8")

    # 示例：解密响应体
    # return { "response": { "bodyBase64": base64.b64encode(decrypt(body).encode()).decode() } }
    return None
`

export function pluginTemplateFiles(type: 'js' | 'python'): Record<string, string> {
  if (type === 'js') {
    return {
      'index.js': JS_TEMPLATE,
      'package.json': '{\n  "type": "module"\n}\n'
    }
  }
  return { 'plugin.py': PYTHON_TEMPLATE }
}

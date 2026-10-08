package com.prism.debug

import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.Socket

/** 经 Mac 代理的 SOCKS5 入站下载 cert.local 的 CA 证书（app 自身不走 VPN，需自带 SOCKS5 客户端） */
object CaFetcher {

  fun fetch(proxyHost: String, proxyPort: Int, timeoutMs: Int = 8000): ByteArray {
    Socket().use { s ->
      s.tcpNoDelay = true
      s.connect(InetSocketAddress(proxyHost, proxyPort), timeoutMs)
      s.soTimeout = timeoutMs
      val out = s.getOutputStream()
      val inp = s.getInputStream()

      // 1. 握手：05 01 00（无认证）
      out.write(byteArrayOf(0x05, 0x01, 0x00))
      out.flush()
      val greet = readN(inp, 2)
      require(greet[0] == 0x05.toByte() && greet[1] == 0x00.toByte()) { "SOCKS5 握手被拒" }

      // 2. CONNECT cert.local:80（domain ATYP，域名在 Mac 端解析）
      val domain = "cert.local".toByteArray(Charsets.US_ASCII)
      val req = ByteArrayOutputStream().apply {
        write(byteArrayOf(0x05, 0x01, 0x00, 0x03, domain.size.toByte()))
        write(domain)
        write(byteArrayOf(0x00, 80))
      }.toByteArray()
      out.write(req)
      out.flush()

      // 3. 应答：VER REP RSV ATYP [+ BND.ADDR + BND.PORT]
      val head = readN(inp, 4)
      require(head[1] == 0x00.toByte()) { "SOCKS5 CONNECT 失败 REP=${head[1].toInt() and 0xFF}" }
      when (head[3].toInt() and 0xFF) {
        1 -> readN(inp, 4 + 2)
        3 -> {
          val len = readN(inp, 1)[0].toInt() and 0xFF
          readN(inp, len + 2)
        }
        4 -> readN(inp, 16 + 2)
        else -> {}
      }

      // 4. HTTP GET /download
      out.write(
        "GET /download HTTP/1.1\r\nHost: cert.local\r\nAccept: */*\r\nConnection: close\r\n\r\n"
          .toByteArray(Charsets.US_ASCII)
      )
      out.flush()

      // 5. 读完整响应，切出 body
      val raw = ByteArrayOutputStream()
      val buf = ByteArray(8192)
      while (true) {
        val n = try {
          inp.read(buf)
        } catch (e: java.net.SocketTimeoutException) {
          break
        }
        if (n < 0) break
        raw.write(buf, 0, n)
      }
      val bytes = raw.toByteArray()
      val sep = indexOf(bytes, "\r\n\r\n".toByteArray())
      require(sep >= 0) { "HTTP 响应异常" }
      val statusLine = String(bytes, 0, bytes.indexOf('\n'.code.toByte()), Charsets.US_ASCII)
      require(statusLine.contains("200")) { "下载失败：$statusLine" }
      return bytes.copyOfRange(sep + 4, bytes.size)
    }
  }

  private fun readN(inp: java.io.InputStream, n: Int): ByteArray {
    val buf = ByteArray(n)
    var read = 0
    while (read < n) {
      val r = inp.read(buf, read, n - read)
      require(r >= 0) { "连接提前关闭" }
      read += r
    }
    return buf
  }

  private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
    outer@ for (i in 0..haystack.size - needle.size) {
      for (j in needle.indices) {
        if (haystack[i + j] != needle[j]) continue@outer
      }
      return i
    }
    return -1
  }
}

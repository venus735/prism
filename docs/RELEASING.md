# 发版说明（Releases）

本项目用 **git tag 触发 GitHub Actions** 自动构建并发布 Release，无需在本地打包。
工作流定义见 [`.github/workflows/release.yml`](../.github/workflows/release.yml)。

## 版本号

单一来源是 `package.json` 的 `version`。发版前保持三处一致：

| 位置 | 字段 | 说明 |
| --- | --- | --- |
| `package.json` | `version` | 语义化版本，如 `0.1.0` |
| `android/app/build.gradle.kts` | `versionName` | 与上面保持一致 |
| `android/app/build.gradle.kts` | `versionCode` | 整数，每次发版 +1（Android 用它判断升级） |

> CI 会校验 tag 与 `package.json` 版本是否一致，不一致会直接失败，避免产物版本错标。

## 发版步骤

```bash
# 1. 改版本号：package.json 的 version、android 的 versionName，并把 versionCode +1
# 2. 提交并推送
git add -A
git commit -m "chore: release v0.2.0"
git push

# 3. 打 tag 并推送（触发自动发布）
git tag v0.2.0
git push origin v0.2.0
```

推送 tag 后，Actions 依次执行：

1. **build-mac**（`macos-14`）：`electron-builder --mac dmg --arm64 --x64`
   → `Prism-<版本>-arm64.dmg`、`Prism-<版本>-x64.dmg`（未签名）
2. **build-android**（`ubuntu-latest`）：安装 JDK 17 + NDK 29，`./gradlew assembleDebug`
   → `Prism-<版本>-android.apk`（debug 签名，可直接安装）
3. **release**：下载上述产物，创建 GitHub Release 并附上安装包，自动生成 release notes

构建进度在仓库 **Actions** 页查看；完成后在 **Releases** 页看到新版本。

## 注意事项

- **tag 命名**必须是 `v主.次.修订`（如 `v0.1.0`），否则不触发工作流。
- **macOS 未签名**：无开发者证书，首次打开需右键 →「打开」，或 `xattr -cr /Applications/Prism.app` 绕过 Gatekeeper。
- **Android debug 签名**：CI 用 debug keystore 签名，便于直接侧载。若要正式发布签名版本，需在仓库 Secrets 配置 keystore（如 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD` 等）并把构建改为 `assembleRelease`。
- **删除误发的 tag**：`git push origin :refs/tags/v0.2.0 && git tag -d v0.2.0`，并到 Releases 页手动删除对应草稿/发布。

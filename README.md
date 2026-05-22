# pi-crew (dev)

Multi-agent crew orchestration extension for pi.

## 本地开发

```bash
pi install /home/thn/pi-crew    # 使用个人 prompts（prompts.local/）
```

## 发布新版本

```bash
./pack.sh sync                           # 同步文件到 release/
cd release
git add -A && git commit -m "v1.1.0"     # 提交（README 不会被覆盖）
git tag v1.1.0 && git push origin master v1.1.0
cd .. && ./pack.sh clean                 # 恢复 symlink
```

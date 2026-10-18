# download-wechat-channels

面向 Codex 的独立视频号 Skill：复用已运行的 [nobiyou/wx_channel](https://github.com/nobiyou/wx_channel) 本地接口，提供连接检查、账号/视频搜索、作者分页采集、批量下载提交与实际文件核验。

本仓库是轻量适配层，不包含微信、wx_channel 可执行文件、证书、数据库、用户数据或登录信息；不是腾讯官方工具，也不保证微信后续版本兼容。

## 前提与安装

- Node.js 22 或更新版本。无 npm 第三方依赖，无全局安装要求。
- 用户已自行启动并配置 wx_channel，默认 API 地址 `http://127.0.0.1:2025`。
- 原生微信内受支持的视频号页面已打开、登录，并完成本地工具要求的连接。**并非脱离原生微信的全无头搜索器**。
- ffprobe 可选但建议已在 PATH；缺少时仅能确认文件存在、大小，不能标记为完整核验成功。本 Skill 不自动安装它。

把仓库克隆到 Codex 可发现的技能目录，然后重启/新建可发现该技能的聊天：

```powershell
git clone https://github.com/Yyh3/download-wechat-channels.git "$env:USERPROFILE/.codex/skills/download-wechat-channels"
```

也可直接在仓库目录使用下列命令。本文命令中的 `D:/archive` 仅为示例，请先创建自己的输出目录，不要把归档写入本仓库。

## 使用

```powershell
node scripts/channels.mjs --help
node scripts/channels.mjs status
node scripts/channels.mjs search-accounts --keyword "青苗讲师团" --max-pages 5 --out D:/archive/accounts.json
node scripts/channels.mjs search-videos --keyword "青苗讲师团" --max-pages 5 --out D:/archive/search-videos.json
```

先核对返回的 `nickname` 和唯一的 `username`，不要自动合并同名账号。再采集选定作者：

```powershell
node scripts/channels.mjs collect --username "EXACT_USERNAME" --max-pages 100 --out D:/archive/videos.json
node scripts/channels.mjs download --manifest D:/archive/videos.json --out D:/archive/receipt.json
node scripts/channels.mjs verify --receipt D:/archive/receipt.json --timeout-seconds 600 --out D:/archive/verification.json
```

可在任一命令加 `--base http://127.0.0.1:PORT`；只允许 `127.0.0.1`、`[::1]` 的 HTTP origin，不接受远程主机、URL 内账号密码、路径或重定向。若原服务启用了本地口令，在当前进程环境变量 `WX_CHANNEL_TOKEN` 中提供；不要把真实口令写进示例、聊天、脚本、命令参数或仓库。

每个输出文件必须使用新的路径，以防覆盖旧证据。下载先保留 `preparing` 回执，成功提交后才改为 `submitted`；如果异常停在 preparing，不要据此重复提交，先检查现有批次。`verify` 仅接受 submitted 回执。

只读检查当前共享批次：`node scripts/channels.mjs batch-status`。不要在未判断上次请求是否已被后台受理前重复提交；回执写入失败不等于后台没开始。此命令不清理、暂停或覆盖任务。

原工具的初始空批次使用 Go nil slice，返回 `tasks:null,total:0`，本适配层将这个已核验的组合识别为空列表；缺失 tasks、其他非数组值或 null 搭配非零 total 均报错，不据此推断后台空闲。所有 `/api/channels/*` 请求默认按至少 1 秒预约间隔串行启动，命令行不提供取消节流选项。

输出与退出码：

| 结果 | 含义 |
| --- | --- |
| 退出码 0 | 命令执行完成；download 只表示提交，不表示文件成功 |
| 退出码 1 | 连接、参数、接口、上游或文件错误 |
| 退出码 2 | 分页未完整，或文件未全部核验通过 |
| `complete:true`（采集） | 已到上游返回的游标终点；不是平台全部历史内容的保证 |
| `state:submitted` | 后台已受理一个批次；仍需 verify |
| `state:verified` | 记录对应实际非空文件，ffprobe 确认 MP4 容器、视频流与正时长 |

## 原理

1. 本地 HTTP 接口经 wx_channel 的 WebSocket 桥接至已就绪的原生微信页面，由原页面执行账号搜索、视频搜索、作者列表及视频详情请求。
2. 采集使用上游 `lastBuffer` 游标，不以短页或页码推断结束。重复游标、缺失续页游标或页数上限均标记不完整；按视频 ID 去重。
3. 下载前重新请求详情，临时取得媒体地址与解码字段，交给原工具现有批量下载器。本适配层不自行实现流量拦截或媒体解码。
4. 核验不会把 HTTP 成功、任务受理或后台 `done` 当作最终交付；还要从下载记录定位真实文件，检查存在性和大小，再运行 ffprobe。

接口字段是从 wx_channel v5.7.13 对应源码的相关处理器与注入客户端核对得到；详见 [API 契约](references/api-contract.md)。此处的兼容性是源码契约核对与离线测试，不等于已在每个原生微信版本完整实测。

## 限制与安全边界

- 仅用于有权访问并获授权下载的普通视频；不支持付费/私密内容绕过、聊天消息抓取、公众号文章、直播及图文媒体归档。
- 不自动启动微信、安装证书、启停/扩展代理、修改系统设置或安全配置。连接不就绪时由用户手动检查原工具及原生页面。
- `connected:true` 不代表搜索/列表/详情能力就绪。旧服务没有 capability 计数时，本 CLI 保守停止；不要据此修改安全设置。
- 单批最多 500 个视频，后台批次是共享状态。已有 pending/downloading 批次时停止；不自动清理、取消、重试或强制重下。较大归档需按用户认可的互不重叠清单分批操作。
- 采集失败会以错误退出，已完成的响应不会逐页落盘；受限/异常分页会输出不完整清单。可调整页数后重新采集，再按 ID 核对，不把旧结果当完整历史。
- ffprobe 缺失时保持 `verified:false`；文件损坏、解码失败、路径不可达均单独报告。校验不等于证明视频版权、真实性或全片逐帧无错误。
- 长数字 ID 在读取 JSON 时无损保留为字符串。若上游 Go/页面早已把 ID 转成浮点并舍入，本适配层无法恢复原始 ID；应从原始字符串来源重新取得。
- 媒体 URL/解码字段只在内存传递，不写入清单/回执。账号名、视频标题和本地路径也可能敏感；输出目录和回执不应公开发布。
- 微信接口、返回字段及风控可能变化；未知字段结构会报错，不能承诺未来稳定性。

## 测试

```powershell
npm.cmd test
npm.cmd run check
```

测试使用本机临时 HTTP 服务和合成文件，不需要微信登录、不连接真实平台、不安装证书、不启用代理。若有 ffmpeg，测试在临时目录生成极小 MP4 并用真实 ffprobe 检查；没有 ffmpeg 时仅跳过该合成视频测试。其余测试覆盖长 ID、游标编码、分页异常、两种 API 包装、批次互斥、媒体地址拼接、实际文件缺失与损坏等。

## 仓库范围

`SKILL.md` 是 Codex 入口；`scripts/channels.mjs` 是零依赖 CLI；`test/` 只有合成测试；`references/api-contract.md` 记录维护用契约。适配层采用 MIT；上游归属和许可见 [NOTICE](NOTICE) 与 [LICENSE](LICENSE)。

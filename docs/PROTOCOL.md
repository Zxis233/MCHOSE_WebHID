# G3 V1 协议依据

初始记录：2026-11-08，Asia/Shanghai。范围为用户的 G3 V1、2.4G 接收器；有线与蓝牙尚未验证。

## 已有实机证据

来源：`D:\MCHOSE_Battery\docs\PROTOCOL.md`、`profiles\g3-v1.toml` 和 `diagnostics\receiver-decoded.json`。原始证据保留在原项目，本项目不复制整个抓包。

- 接收器 VID/PID `258A:0138`，USB 接口 1。
- 厂商顶层集合 `FF02:0002`，Report ID `09`。
- Input 为 7 字节 payload，加 Report ID 共 8 字节。
- Feature 为 519 字节 payload，加 Report ID 共 520 字节。
- ID 9 未与标准键盘/鼠标集合共享；完整报告描述符见原解析文件第 529–541 行、捕获帧 78。
- 先前实时 Windows 能力检查也得到 InputReportByteLength=8、FeatureReportByteLength=520。

真实电量样本（Windows hidapi / USBPcap 布局）：

```text
09 0A 05 61 00 00 00 00
         ^^ 97%
```

WebHID 的 `inputreport.reportId` 是 `9`，`inputreport.data` 是 `0A 05 61 00 00 00 00`，**不含 Report ID**。因此电量是 WebHID DataView 的 offset 2。长度、前缀和 0–100 范围均须校验。

连接样本：`09 0A 02 01 00 00 00 00`。状态 1 在线、0 离线；0 的语义有官方静态解析依据，但旧抓包未单独实测鼠标开关造成的离线事件。其他值忽略。不推断充电状态。

原独立电量程序已验证官方 HUB 退出后可以被动读取；这不能替代本项目自己的浏览器实测。

## 本项目浏览器实测

2026-11-08 14:51:27（Asia/Shanghai），Chrome 159 经 WebHID 接收 `09 0A 05 42 00 00 00 00`，解析为 66%。官方 HUB 未运行，原电量托盘仍在运行。14:53:59 拔出时读数清空；14:59:55 重新上电并连接后再次收到 66%。未要求原电量托盘退出。

浏览器返回的 FF02:0002 集合中，ID 9 的 Input payload 为 7 字节，Feature payload 为 519 字节，符合旧描述符。HIDDevice 同时包含接口上其他非受保护集合；筛选器不等于只授权一个顶层集合，应用必须自行忽略非 ID 9 输入。

证据：`diagnostics/2026-11-08/browser-initial.json`、`browser-unplugged.json`、`browser-replugged.json`。后续日志还观察到 `09 0A 02 00…` 和 `09 0A 02 01…`；诱发条件未单独控制，不把休眠与关机混作同一实测。

## 产品识别与配置线索

原抓包帧 7695–7698 为接口 1、ID 9、Feature SET/GET：

```text
SET: 09 0D 05 01 01 00 06 [补零到 520 字节]
GET: 09 0D 05 01 01 00 06 00 04 00 00 00 00 19
```

响应末 6 字节匹配 `D:\MCHOSE\YProduct.xml:12` 的 G3 `Productpassword="040000000019"`。它不是电量响应。

本项目已通过 WebHID 复现。`sendFeatureReport(9, payload)` 的 payload 为 519 字节，不含 ID；`receiveFeatureReport(9)` 在本机返回含 ID 的 14 字节 DataView。不要将 Input API 的“不含 ID”规则套到 Feature 返回上。

首次识别于 15:04:32 发起、约 5 秒后读取失败；同一会话在 15:02:52 已记录鼠标离线，15:08:00 重新上线。15:10:50 与 15:15:59 相同请求成功。状态相关性有日志依据，但没有独立控制试验，不宣布唯一原因，也不把通用 NotAllowedError 直接当权限拒绝。

## 新抓包证据

`diagnostics/2026-11-08/browser-feature-02.pcap`：1,456,566 字节，31,266 个完整记录，仅 bus 1/device 43；设备描述符帧 2 确认 `258A:0138`、bcdDevice `0210`。地址 43 只适用于本轮。离线解码文件同名 `.decoded.json`，无截断警告、无待配对控制请求。捕获采用有界中断，可能遗漏停止后的流量；已确认所有 USBPcap 进程退出。

- 网页识别：帧 5049–5052，SET 长 520，GET 请求长 **1032**，成功返回 14 字节。
- 官方识别：帧 13771–14260，SET/GET 请求长均 520，成功返回相同 14 字节。
- 因接口还包含 ID 6、总长 1032 的 Feature 报告，浏览器使用接口最大长度。实测表明此差异本身没有阻止本次产品识别，不作为已证实的失败原因。
- 官方基础配置读取：帧 20267–20272，见下文。
- 官方另有 `09 0C 09 01 01 00 01 00…` 查询，响应 `09 0C 09 01 01 00 01 00 42`；末字节与当时 66% 一致，但本项目未实现该主动电量查询。

## 基础配置读取

官方抓包中的固定请求（总长 520）：

```text
SET: 09 00 44 00 01 00 90 01 [补零至 520]
GET: 09 7E 44 00 01 00 90 01 [400 字节配置数据]
```

SET 帧 20267，GET 帧 20271，二者相隔约 107 ms；响应帧 20272 实长 408，完成状态 0。本项目使用 100 ms 等待，并核对固定头、400 字节长度和配置块校验。

此配置响应的 byte[1] 等于 `sum(byte[2..407]) mod 256`，本次为 `7E`。该规则仅用于已观察的配置块，不泛化到产品识别响应。官方缓存 Base 的校验字节可能不随编辑同步更新，不能把缓存文件直接当作可发送报文。

下列 offset 均包含首字节 Report ID：

| 字段 | offset / 编码 | 本次值 |
| --- | --- | --- |
| 回报率 | byte[10]：1/2/3/4 → 125/250/500/1000 Hz | 4 → 1000 Hz |
| DPI 数量 | byte[11] 低半字节 | 2 |
| 当前档位 | byte[11] 高半字节，按本档案从 1 计 | 2 |
| X DPI | 从 byte[15] 开始的 little-endian uint16，`(值+1)*100` | 1600、2400 |
| Y DPI | 从 byte[35] 开始，同上 | 1600、2400 |

用户已在官方 HUB 核对：两档 1600/2400，当前第 2 档，1000 Hz，随后完全退出 HUB。15:27:07，网页 v0.2.0 独立读取到相同值与校验，证据：`diagnostics/2026-11-08/browser-config-read.json`。原始响应样本在 `tests/fixtures/g3-v1-config-read.json`。

当前按官方 G3 配置文件的 100 步进、最多 6 档和 12000 上限解析；其他步进/更多档位组合尚未实测。byte[12/13/14/82] 等保留为未完整验证字段，不在产品界面猜测单位或功能。

官方配置参考：

- `D:\MCHOSE\Products\G3\DpiEditConfig.xml`：回报率、DPI、消抖、休眠等映射。
- `D:\MCHOSE\Products\G3\UserConfig\Base.xml`：按键地址与编码。
- `D:\MCHOSE\Products\G3\G3_data.ini`：原始配置字节串。
- G3/G3 Pro/G7 共用部分 VID/PID，产品识别须单独验证。

## DPI 写入与按键通知

原生捕获 `dpi-stage2-2400-2500-2400.pcap`：3,773,144 字节、81,074 完整记录，仅 bus1/device43；无截断警告、无待配对控制请求，所有捕获进程已退出。

- 初始读取响应：帧38934，408字节，2档1600/2400、当前第2档、1000Hz。
- 改2500：帧43803，15:31:24.677，完整520字节 SET，前缀 `09 40 04 00 01 00 90 01`。
- 恢复2400：帧68381，15:31:50.706，前缀 `09 3E 04 00 01 00 90 01`。
- 两条写入完成状态均0。写命令byte[2]=04，读命令44；byte[1]=sum(byte[2..519])mod256。
- 第2档X/Y的uint16分别在offset17、37。2500编码24（18h），2400编码23（17h）。除这两处和checksum，两条写包完全一致。恢复包等于初始读取配置改写入头并补零到520。

用户补充在2500期间按了两次DPI键：2500→1600→2500。帧48643（15:31:27.861）为 `09 0A 03 01 00 00 00 00`，帧50575（15:31:28.880）为 `09 0A 03 02 00 00 00 00`；均为endpoint82、info1的Interrupt IN完成记录，非host配置写。两条通知与所述档位顺序一致；本项目在该G3档案中将subtype03解析为1起算的当前档位，不因此重抓。

本项目保存时重新从硬件取基线，修改指定档位X/Y，以04写头及重算校验构造519字节payload；不写回官方缓存文件。发送前备份完整408字节。写后读回整个预期配置相同才判定成功；任何离线事件或档位通知使正在进行的保存中止/不确认，不自动重写。

Chrome v0.3.0 页面已记录15:49:36保存2500、15:49:56恢复2400，两次完整读回都匹配。主代理随后通过chrome-devtools再次读取，与原始408字节基线逐字节一致。完整证据：`browser-v03-save-cycle-observed.json`；摘要：`browser-v03-save-cycle-verification.json`。即时保存闭环已实测；断电持久化另测，不能由上述即时读回推出。

随后另做OFF重开测试：主代理通过chrome-devtools将第2档设为2500并读回，等待至少5秒后，用户确认鼠标OFF约5秒再回2.4G并唤醒，接收器保持插入、官方HUB关闭。网页重新读取仍为1600/2500、当前第2档、1000Hz。之后网页恢复第2档2400并读回，完整408字节与最初基线一致。

证据：`browser-power-before-2500.json`、`browser-power-after-2500.json`、`browser-power-restored-2400.json`；摘要 `power-cycle-verification.json`，均在本轮诊断目录。这证明所述鼠标OFF/重开操作后的参数保留；未独立测量供电轨，也未据此认定具体存储介质。

回报率写入、消抖、按键与宏尚未实现，不据配置字段映射直接扩展未知命令。

## 参考

- [Chrome WebHID](https://developer.chrome.com/docs/capabilities/hid)
- [WebHID 规范](https://wicg.github.io/webhid/)
- [USBPcap 捕获机制](https://desowin.org/usbpcap/capture_limitations.html)

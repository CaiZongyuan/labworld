# 实验室运行信息底座的组件调查

核对日期：2026-10-02。本文是方案选型记录，尚未安装依赖、运行集成验证或改变应用架构。主体调查的 GitHub 来源固定到本次读取的提交；附录中的 node-opcua 链接使用当日读取的 `master`。这些来源不等于本项目已经选定的依赖版本。

调查问题：在 Rust/Axum/Tokio/PostgreSQL 与 React/R3F 的技术约束下，如何复用成熟组件，支持实验室对象、关系、能力、观测、基础命令、历史和 Agent 查询，同时控制许可与部署复杂度。

首轮前提来自已接受的 [ADR 0006](../adr/0006-server-owned-virtual-device-programs.md)：设备程序在后端运行，同类设备共用代码，每个设备实例独立维护配置、状态和进度；后端重启后将原运行标为中断，由用户显式重新启动。本文保留组件候选及取舍依据；当前实施范围与任务以 [GitHub 规格 #1](https://github.com/CaiZongyuan/labworld/issues/1)为准，资产持久化从 [#2](https://github.com/CaiZongyuan/labworld/issues/2)开始。

## 建议主路径

建议保留现有应用与数据库，以 `ractor` 管理进程内的独立设备程序，以 Rust `jsonschema` 校验版本化能力参数与报告的数据形状。实验室对象关系、观测的可信顺序、命令记录和重启行为仍由应用定义并持久化。

WoT Thing Description 可以提供设备描述的参考词汇，首轮无需采用 Eclipse 的运行组件。LabThings-FastAPI 和 PyLabRobot 保留为后续 Python 真实硬件适配器的候选。推荐分工如下；这是调查后的设计建议，而非已有功能：

| 工作                                   | 建议承担者                            | 理由与边界                                                                 |
| -------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| 对象身份、位置、关系和权限             | 应用领域模块与 PostgreSQL             | 这些属于 Lab Word 的实验室信息规则；本次调查的设备组件均未提供完整产品模型 |
| 属性、动作、事件的能力描述             | 版本化的应用合同，参考 WoT TD         | 采用可理解的标准词汇，随后可增加符合 TD 的导出                             |
| 设备配置、动作输入和观测值的结构校验   | Rust `jsonschema`                     | 复用 JSON Schema 校验器，业务权限和状态前置条件仍在领域模块执行            |
| 每实例的内存状态、消息和定时更新       | `ractor` + Tokio                      | 复用 Actor 生命周期与单实例串行处理能力                                    |
| 命令接受、执行记录、观测历史、重启中断 | 应用领域模块与 PostgreSQL             | 不能以进程内 mailbox 或 RPC 回复代替持久化业务记录                         |
| 页面与 Agent 的查询和操作              | 同一组鉴权 HTTP/OpenAPI 接口          | 两类客户端使用相同的对象、能力、命令和观测合同                             |
| Python 驱动的仪器                      | 后续可选的 LabThings-FastAPI 适配服务 | Rust 底座继续拥有统一身份、权限和持久化记录                                |

暂不引入完整 IoT 平台，是基于首轮采用内置设备程序的范围判断：目前需要一条可讲解、可验证的运行链路。先建立设备端适配合同，待真实硬件数量、协议和跨主机部署要求出现后，再评估额外平台。这不是对完整 IoT 平台优劣的通用结论。

## ractor：设备程序运行组件

以下事实均于 2026-10-02 核对。

| 已核对事实                                                                                                             | 官方依据                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ractor 是 Rust Actor 框架，项目许可为 MIT                                                                              | [README][ractor-readme]、[Cargo][ractor-cargo]、[LICENSE][ractor-license]         |
| 默认 feature 包含 `tokio_runtime`，可以与普通 Tokio 任务共存，不要求另起一个独立 Actor 系统服务                        | [Cargo][ractor-cargo]、[README][ractor-readme]                                    |
| 每个 Actor 有自己的 `State`，在 `pre_start` 初始化；单个 Actor 的 handler 不并行执行                                   | [运行语义][ractor-semantics]                                                      |
| 用户消息通道对单发送方保持 FIFO；不同发送方之间没有顺序保证，信号、停止、监督事件比普通消息优先                        | [运行语义][ractor-semantics]                                                      |
| 提供监督事件、RPC 与定时器；重启策略由监督者决定，定时器通过向 mailbox 投递消息工作，准确时间是 best effort            | [运行语义][ractor-semantics]                                                      |
| `Stop` 允许当前 handler 完成后退出；`Kill` 会立即中断当前处理                                                          | [运行语义][ractor-semantics]                                                      |
| 普通 Actor 的消息与监督通道在源码中通过 `mpsc_unbounded()` 创建，后者使用 Tokio `unbounded_channel()`                  | [ActorProperties 源码][ractor-properties]、[concurrency 源码][ractor-concurrency] |
| Factory 在 Actor mailbox 之外拥有自己的工作队列，可配置队列限制；`FactoryRef::dispatch_job` 仍通过 `cast` 投递到 Actor | [FactoryRef 源码][ractor-factory-ref]                                             |

因此，不能把“有界 mailbox、全局有序、持久化任务、自动恢复”写成采用 ractor 后自动获得的保证。官方概述对 factory 队列的说明较宽泛，普通 Actor 的容量边界应以本次核对的创建代码为准。

应用仍应承担以下规则。这些是基于上述事实的设计结论，不是 ractor 自带功能：

- 在持久化命令入口限制未完成命令和负载，受控地派发；不能靠一个前置队列限额，就声称所有内部消息都有容量上限。定时消息也应限制未处理数量，避免重复积压。
- 以短消息或 tick 推进温控渐变和仪器长任务，让停止动作有处理机会。将整段任务都放在一个长时间等待的 handler 中，会延后普通控制消息和 `Stop`。
- 记录设备运行代次和观测序号，写数据库时检查当前运行身份，拒绝旧运行的更新。进程内 Actor 身份不能代替跨进程的资源占用保护或数据库条件写入。
- 接受命令与记录待派发工作需要可靠的数据库边界；派发后的执行状态、重复请求处理、超时和不确定结果由业务合同定义。Actor RPC 回复不能单独证明命令已持久化或物理动作已完成。
- 监督者按已接受的中断规则处理失败，避免默认重启策略悄悄恢复仪器任务。ractor 可以减少进程内任务生命周期的代码，但不替换需要持久化的工作记录及既有任务业务。

首个集成验证应只使用进程内 Actor，验证两实例互不影响、控制能打断业务任务、Actor 失败可被观察、旧运行报告被拒绝以及入口负载受限；通过后再决定并锁定具体版本。本次没有运行这些验证。

## jsonschema：能力数据的校验组件

以下事实均于 2026-10-02 核对。

| 已核对事实                                                                               | 官方依据                                                                                                |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Rust `jsonschema` 仓库使用 MIT 许可；包的许可继承 workspace 配置                         | [workspace Cargo][jsonschema-workspace]、[crate Cargo][jsonschema-cargo]、[LICENSE][jsonschema-license] |
| 支持 JSON Schema Draft 4、6、7、2019-09、2020-12                                         | [README][jsonschema-readme]、[库文档][jsonschema-lib]                                                   |
| 可构建并复用 validator、校验实例、迭代错误，并以 `meta::validate` 校验 schema 文档本身   | [README][jsonschema-readme]、[库文档][jsonschema-lib]                                                   |
| 默认 features 开启 HTTP 与文件 `$ref` 解析；关闭默认 features 可禁用这两种自动解析       | [crate Cargo][jsonschema-cargo]、[库文档][jsonschema-lib]                                               |
| 支持注册预先已知的 schema 资源和自定义 retriever；需要按需异步读取时可用 `resolve-async` | [库文档][jsonschema-lib]                                                                                |
| 在较新的 draft 中，`format` 不必默认执行校验，可显式配置 `should_validate_formats(true)` | [库文档][jsonschema-lib]                                                                                |

建议应用自己的能力参数 schema 明确采用 Draft 2020-12，发布时校验 schema，并缓存可复用 validator。首轮关闭默认 HTTP/文件解析，只允许引用已登记的版本化资源；不要让客户端提供的引用决定运行期网络或文件读取。需要日期等格式检查时显式开启并验证相关配置。

schema 校验回答“温度是不是数值、是否落在允许区间”等结构问题。实例是否存在、操作者是否有权限、设备是否空闲、单位和设定值是否符合设备业务，仍由应用规则决定。

## WoT TD：参考设备描述标准

以下事实均于 2026-10-02 核对，采用 W3C 2023-12-05 Recommendation 版本。

| 已核对事实                                                                                                       | 官方依据                                       |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Thing Description 是描述物理或虚拟实体的元数据与交互接口的信息模型与表示格式，默认使用 JSON，也可作 JSON-LD 处理 | [TD Abstract][wot-td]                          |
| Property 表达可读或可写的状态，并可支持观测更新                                                                  | [PropertyAffordance][wot-properties]           |
| Action 表达改变状态或启动过程的函数调用                                                                          | [ActionAffordance][wot-actions]                |
| Event 描述向 Consumer 异步推送数据的事件源                                                                       | [EventAffordance][wot-events]                  |
| 标准描述还包含接口 forms、安全配置等；只有属性、动作和事件三个列表不足以表示完整 TD                              | [TD 示例][wot-example]                         |
| 标准文档采用 W3C Software and Document Notice and License；它与某个 Eclipse 实现的代码许可是不同来源             | [TD 文档][wot-td]、[W3C 许可文本][wot-license] |

设计结论：首轮可以借鉴“属性、动作、事件”组织能力描述，不必运行 node-wot 或 Ditto。应称为应用自己的能力合同；在完整 TD 导出通过对应格式和互操作检查前，不声称 WoT TD 合规。应用 JSON Schema 与 WoT DataSchema 的映射也需要单独核对。

TD 是描述合同，运行期的持久化回执、观测次序、重复命令处理和崩溃恢复必须落实在具体实现中。即使采用 Action 的查询或取消接口描述，也不会由一份 TD 文档自动产生这些业务保证。

## 可选的 Python 硬件适配器

以下事实均于 2026-10-02 核对。

| 候选                      | 已核对事实                                                                                                                                                           | 官方依据                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| LabThings-FastAPI         | MIT 许可；基于 FastAPI/Pydantic，将 Python 实验仪器功能暴露为 HTTP，并生成 OpenAPI 和 TD；使用 Thing 类、类型提示和装饰器描述能力                                    | [README][labthings-readme]、[文档][labthings-docs]、[LICENSE][labthings-license] |
| LabThings-FastAPI actions | 每次 HTTP action 调用在独立线程中运行，返回 `201` 与 Invocation 查询链接；状态与结果可以查询。取消是合作式的，需要 action 检查取消条件，例如使用 `cancellable_sleep` | [Actions 文档][labthings-actions]                                                |
| PyLabRobot                | MIT 许可；Python 库，覆盖受支持的移液机器人、读板机、泵、秤、加热振荡器等实验自动化设备；具体支持范围需按实际硬件核对                                                | [README][pylabrobot-readme]、[LICENSE][pylabrobot-license]                       |

建议将它们放在真实设备适配边界，按具体仪器需要选择。引入 Python 适配器是后续选项，不是首轮虚拟设备程序的必要依赖，也不是把现有 Rust 信息底座整体迁到 Python 的理由。

LabThings 的 Invocation 概念可提供接口设计参考；本次调查没有验证其跨进程持久化恢复、硬件互斥或与本项目鉴权的整合，不能把这些能力列为已解决。

## 许可与验证范围

本次查看的 ractor、jsonschema、LabThings-FastAPI 和 PyLabRobot 项目许可证均为 MIT；这些许可证要求保留版权及许可通知。这一结论覆盖列出的项目文件，不表示所有传递依赖、模型资产或设备 SDK 都采用相同许可，也不表示 MIT 没有义务。[ractor LICENSE][ractor-license]、[jsonschema LICENSE][jsonschema-license]、[LabThings LICENSE][labthings-license]、[PyLabRobot LICENSE][pylabrobot-license]，均核对于 2026-10-02。

已完成官方仓库、源码、规范和许可证的读取。尚未锁定依赖版本、做完整传递依赖清单、安装组件、运行集成或性能测试。主路径推荐来自职责匹配；是否接纳 ractor 应由上述小规模集成验证决定，而不把一份文档调查视为运行验证。

## 附录：现成虚拟设备从哪里来

补充核对日期：2026-10-02。本附录只解释可定位的官方示例来源；未安装依赖或启动服务器。

现成的协议测试服务器能够产生数据并响应请求，可以先充当设备端。但“能通过协议读写数据”与“完整模拟某台仪器”是两种能力；具体仪器的温控、任务、故障和停止规则，需要查看示例是否已经包含，再决定补多少行为。

| 可复用的官方来源                                                                                                                              | 已有行为                                                                                                                                            | 仍需定义的部分                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| node-opcua 的 [simple_server.cjs][opcua-simple]，项目 [MIT 许可][opcua-license]                                                               | 创建 Temperature 变量，数值为 `20 + 10 * sin(Date.now() / 10000)`，附带 `sourceTimestamp`，并构造协议一致性测试地址空间；可用于理解连接、读写和订阅 | 该温度随时间波动，并非根据培养箱设定值升温；完整仪器的动作、状态关联和任务语义仍需补充                     |
| UniteLabs SiLA Python 的 [测试服务器入口][unitelabs-server] 与 [ObservableCommandTest][unitelabs-command]，项目 [MIT 许可][unitelabs-license] | `Count` 按参数计数和等待，报告进度、剩余时间与中间响应；`EchoValueAfterDelay` 演示延时执行                                                          | 它是命令与数据类型的测试示例，未表示培养箱、离心机或移液仪的完整行为；需要实现具体 SiLA Feature 的设备逻辑 |

UniteLabs 当前维护项目在 [GitLab][unitelabs-sila]，发布包名为 `unitelabs-sila`。旧 `sila2` 项目的发布者 [README][legacy-sila-pypi] 标为 **Maintenance-only（仅维护）** 并指向此项目，应避免将旧项目说成完全停止维护，或将两个包混为一谈。

PyLabRobot 的 [Chatterbox 实现][pylabrobot-chatterbox]明确用于无设备测试并打印操作；本次核对版本位于 `legacy`，因此不把它介绍为现成的完整仪器模拟器。

[ractor-readme]: https://github.com/slawlor/ractor/blob/1af0aaad5d340cda27c5370768c6c96a0376a543/README.md
[ractor-cargo]: https://github.com/slawlor/ractor/blob/1af0aaad5d340cda27c5370768c6c96a0376a543/ractor/Cargo.toml
[ractor-license]: https://github.com/slawlor/ractor/blob/1af0aaad5d340cda27c5370768c6c96a0376a543/LICENSE
[ractor-semantics]: https://github.com/slawlor/ractor/blob/1af0aaad5d340cda27c5370768c6c96a0376a543/docs/runtime-semantics.md
[ractor-properties]: https://github.com/slawlor/ractor/blob/1af0aaad5d340cda27c5370768c6c96a0376a543/ractor/src/actor/actor_properties.rs
[ractor-concurrency]: https://github.com/slawlor/ractor/blob/1af0aaad5d340cda27c5370768c6c96a0376a543/ractor/src/concurrency.rs
[ractor-factory-ref]: https://github.com/slawlor/ractor/blob/1af0aaad5d340cda27c5370768c6c96a0376a543/ractor/src/factory/factory_ref.rs
[jsonschema-workspace]: https://github.com/Stranger6667/jsonschema/blob/3349510e087b6666b9427339ed2d686fe2e4e786/Cargo.toml
[jsonschema-cargo]: https://github.com/Stranger6667/jsonschema/blob/3349510e087b6666b9427339ed2d686fe2e4e786/crates/jsonschema/Cargo.toml
[jsonschema-license]: https://github.com/Stranger6667/jsonschema/blob/3349510e087b6666b9427339ed2d686fe2e4e786/LICENSE
[jsonschema-readme]: https://github.com/Stranger6667/jsonschema/blob/3349510e087b6666b9427339ed2d686fe2e4e786/README.md
[jsonschema-lib]: https://github.com/Stranger6667/jsonschema/blob/3349510e087b6666b9427339ed2d686fe2e4e786/crates/jsonschema/src/lib.rs
[wot-td]: https://www.w3.org/TR/2023/REC-wot-thing-description11-20231205/#abstract
[wot-properties]: https://www.w3.org/TR/2023/REC-wot-thing-description11-20231205/#propertyaffordance
[wot-actions]: https://www.w3.org/TR/2023/REC-wot-thing-description11-20231205/#actionaffordance
[wot-events]: https://www.w3.org/TR/2023/REC-wot-thing-description11-20231205/#eventaffordance
[wot-example]: https://www.w3.org/TR/2023/REC-wot-thing-description11-20231205/#simple-thing-description-sample
[wot-license]: https://www.w3.org/copyright/software-license-2023/
[labthings-readme]: https://github.com/labthings/labthings-fastapi/blob/c33924d4d01027d2a29a020d3d7178da3c56fdff/README.md
[labthings-docs]: https://github.com/labthings/labthings-fastapi/blob/c33924d4d01027d2a29a020d3d7178da3c56fdff/docs/source/index.rst
[labthings-license]: https://github.com/labthings/labthings-fastapi/blob/c33924d4d01027d2a29a020d3d7178da3c56fdff/LICENSE
[labthings-actions]: https://github.com/labthings/labthings-fastapi/blob/c33924d4d01027d2a29a020d3d7178da3c56fdff/docs/source/actions.rst
[pylabrobot-readme]: https://github.com/PyLabRobot/pylabrobot/blob/6262d633394cecb76673f31c79f10cb0ab2fa001/README.md
[pylabrobot-license]: https://github.com/PyLabRobot/pylabrobot/blob/6262d633394cecb76673f31c79f10cb0ab2fa001/LICENSE
[opcua-simple]: https://github.com/node-opcua/node-opcua/blob/97c753e4a4d2858f5f3dc328ddb3d50a2094abe0/packages/node-opcua-samples/bin/simple_server.cjs
[opcua-license]: https://github.com/node-opcua/node-opcua/blob/97c753e4a4d2858f5f3dc328ddb3d50a2094abe0/LICENSE
[unitelabs-sila]: https://gitlab.com/unitelabs/sila2/sila-python/-/blob/e82858c5a49030f4b0c6919377b1106399901d43/README.md
[unitelabs-server]: https://gitlab.com/unitelabs/sila2/sila-python/-/blob/e82858c5a49030f4b0c6919377b1106399901d43/examples/server/__main__.py
[unitelabs-command]: https://gitlab.com/unitelabs/sila2/sila-python/-/blob/e82858c5a49030f4b0c6919377b1106399901d43/examples/server/observable_command_test.py
[unitelabs-license]: https://gitlab.com/unitelabs/sila2/sila-python/-/blob/e82858c5a49030f4b0c6919377b1106399901d43/LICENSE
[legacy-sila-pypi]: https://pypi.org/project/sila2/
[pylabrobot-chatterbox]: https://github.com/PyLabRobot/pylabrobot/blob/6262d633394cecb76673f31c79f10cb0ab2fa001/pylabrobot/legacy/liquid_handling/backends/chatterbox.py

# Lab Word 项目文档

Lab Word 面向实验室数字孪生。应用持久保存资产、Lab、对象和布局。后端程序提供来源明确的设备观测和 Task。

## 选择你的任务

| 任务             | 从哪里开始                                                     | 可观察结果                  |
| ---------------- | -------------------------------------------------------------- | --------------------------- |
| 启动现有应用     | [快速开始](quickstart.md)                                      | API 就绪、Web 注册页可访问  |
| 查看设备模型     | [Lab 与资产库](../guides/lab-viewer.md)                        | 查看模型并发布持久 GLB 资产 |
| 管理设备生命周期 | [对象生命周期](../tutorials/entity-lifecycle.md)               | 替换外观并归档已停止 Entity |
| 修改项目         | [项目结构](../architecture/project-structure.md)               | 找到应用组装与业务所有权    |
| 查阅接口         | [API](site:reference/api.md)与[配置](site:reference/config.md) | 定位当前生成合同与默认值    |

## 当前能力与计划

应用通过[平台能力](../guides/platform.md)提供身份、成员、知识库、文件与任务。Lab 是登录后的默认入口。已接受的 Viewer 和 Foundation 预览提供体验基准。

从[持久资产](../tutorials/persistent-assets.md)开始跟做双语教程，依次建立世界身份、布局、程序、同步、Task 和历史。[对象生命周期](../tutorials/entity-lifecycle.md)交付归档和外观替换。下一阶段进行综合规模验收。真实设备接入仍属后续范围。[产品范围](../architecture/lab-word.md)说明这些边界。

## 阅读与维护

教程逐步增加同一份 Lab 业务代码；独立指南以任务、前提、源码、命令、结果和失败边界组织。当前内容只声明仓库实际存在的能力，预览与计划分别标明状态。

中英文页面按章节配对，API 与配置从实现生成。修改功能时同步更新相关文档和[验证入口](../testing/t01-feedback-loop.md)，写作规则见[维护项目文档](../guides/maintain-docs.md)。

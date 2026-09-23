# 采云数据格式 / Cloudig Schemas

records/ 是五类业务记录的字段规则；program/ 是程序状态及其公共依赖。index.json 登记对应路径、标识与 SHA-256。

$id 中的 https://cloudig.local/ 是类型标识，不是下载地址。离线校验时先向 JSON Schema 2020-12 校验器注册本目录的全部 Schema，再按 $id 选择根规则，无需网络。

JSON Schema 只覆盖字段形状，不替代引用关系、真实日期、消息无环及资源字节/哈希等语义校验；完整规则见《结构与规范》。不得把所有通过 Schema 的文件宣称为已通过全部采云校验。

These files are offline JSON Schema 2020-12 contracts. Register all files before validation; their IDs are not network endpoints. Semantic and cross-file checks remain required.

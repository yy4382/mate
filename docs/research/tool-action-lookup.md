# 持久工具身份的只读查询探针

`apps/control-plane/benchmarks/tool-action.mjs` 在合成业务库中建立每 Agent 原生 tool task 的稳定关联，测量按身份读取对应工具与输入；它不构造或扫描 transcript。运行 `pnpm build:control-plane` 后执行 `node apps/control-plane/benchmarks/tool-action.mjs`，输出包含环境、查询计划、分布和解析量。结果属于本机性能观察，不能替代真实副作用与恢复场景。

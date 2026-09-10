# AI-Assisted Development Standards

> 此文件由 workflow 部署脚本自动同步到目标项目根目录。
> AI 编程助手（Codex、Claude、Cursor）会自动读取此文件，作为开发规范的基线。

---

## 适用范围

本文件中的 `gryy-java-simple`、`gryy-java-lite`、JavaDoc、H2Integration、MyBatis、Maven 和 Java 编码规范，仅适用于 Java/Maven 项目，或本次变更明确触及 Java 代码、Java 测试、Maven 配置、MyBatis/Mapper/SQL 持久层逻辑的场景。

如果目标项目不是 Java/Maven 技术栈，或者本次任务只涉及前端、脚本、配置、文档、Go/Python/Node 等其他语言，不要引用 `gryy-java-simple` / `gryy-java-lite`，也不要强套 JavaDoc、H2Integration、MyBatis 或 Java 专属规范；应按该项目实际语言、框架、测试工具和本地 `AGENTS.md` / README 约定执行。

## 默认开发执行基线

在 Java/Maven 项目中，任何默认开发、缺陷修复、重构或问题处理，默认使用 `$gryy-java-simple` 的手工 TDD 基线。除非用户明确要求只分析或禁止改代码，否则不要只改实现不补测试。

- 普通 chat 开发默认按 `gryy-java-simple` 执行：不启动外部 sh runner，不要求 `state.json`，允许当前 agent 直接读写代码、补测试、跑 Maven，但必须先补/调整测试，再改实现。
- `gryy-java-simple` 默认允许并鼓励 H2Integration；只要改到 Mapper、DAO、MyBatis XML、SQL、数据库字段映射、分页筛选、批量查询或持久层数据组装，就必须优先补 H2Integration 测试。
- 纯 Service 分支、金额/数量计算、状态流转、参数校验、异常语义和外部依赖编排，优先补 Mock 单元测试；复杂链路用 Mock 单测覆盖业务分支，用 H2Integration 覆盖 Mapper/SQL/字段映射。
- 如果用户明确提到 `$gryy-java-lite`、`/gryy-java-lite`，或提供设计文档并要求按该 workflow 执行，必须使用 `.agents/scripts/superpowers/java-lite-run.sh init -> register-tasks -> auto-run-all -> final-verify` 的完整流程，不允许跳过 `state.json`、progress 或终态验证。
- 没有设计文档时，不强行启动完整 `$gryy-java-lite` 工作流；默认回到 `gryy-java-simple` 手工 TDD 基线，并在最终回复里说明已跑的测试/编译/规范检查。
- 如果客观条件导致无法运行编译、测试或规范检查，必须在最终回复中明确说明阻塞原因和未验证风险，不能把未执行的验证说成已通过。

## Java 强制规则 (MUST)

### 1. 日期时间 API
统一使用 `java.time` 体系（`LocalDateTime`、`LocalDate`、`LocalTime`）。
禁止 `java.util.Date`、`java.sql.Date`、`java.sql.Timestamp`。

### 2. 禁止魔法值
业务状态码、类型码、阈值等必须使用常量、枚举或明确命名的对象。不得在代码中散落裸数字或裸字符串。

```java
// ❌ if (status == 10)
// ✅ if (status == OrderStatus.PENDING)
```

### 3. 构造器注入
使用 `@RequiredArgsConstructor` + `private final`。禁止 `@Autowired` 字段注入。

### 4. 事务范围最小化
仅在需要事务的方法上加 `@Transactional(rollbackFor = Exception.class)`，禁止类级别 `@Transactional`。不要把查询和大段业务逻辑包进事务。

```java
// ✅ 方法级
@Transactional(rollbackFor = Exception.class)
public void createOrder(CreateOrderRequest req) { ... }

// ❌ 类级 + 缺 rollbackFor
@Transactional
@Service
public class OrderService { ... }
```

### 5. 读写分离与事务提交一致性
公司数据库默认写主读从，主从同步存在约 50-150ms 延迟。只有链路确实存在“写入后立即依赖刚写入数据”时，才启用强一致机制：

- 新增读主、afterCommit、延迟或重试前，必须写明写入点、立即读取点、读取数据源和可复现失败。仅因系统存在主从复制，不构成新增强一致机制的依据。
- 禁止在事务提交前触发依赖新数据的后续处理、异步任务、回调、消息发送或远程调用。
- 优先复用同业务域既有消息时序、写入返回值或内存快照；证实存在强一致问题后，才在 afterCommit / 事务后事件或精确读主中选择一个最小机制。
- 不得直接扩大为全局读主配置来修复单一链路问题。如果写后立即读是本次新设计制造的，应先简化时序或减少二次读取。
- 禁止用固定 sleep 掩盖主从延迟；重试或等待同步必须有明确依据、上限、日志和测试。

### 6. SQL 注入防范（最高优先级）
MyBatis XML 中参数绑定用 `#{}`。`${}` 仅允许用于动态表名/列名，且值必须来自代码枚举白名单，绝不可直接传入用户输入。

### 7. 数据库查询与 SQL 复杂度
新增或修改 SQL 必须保持简单、可解释、可维护：

- 禁止大量 `JOIN`：单条查询原则上不超过 2 个 `JOIN`，3 个及以上 `JOIN` 视为大量关联，必须拆成主表分页/筛选 + 关联表批量查询 + Java 侧组装。
- 禁止在业务 SQL 中使用数据库函数做格式化、转换、默认值、字符串处理、日期处理或业务判断，例如 `DATE_FORMAT`、`IFNULL`、`COALESCE`、`CONCAT`、`SUBSTR`、`NOW()` 等。
- 禁止新增或依赖存储过程、数据库函数、视图；不得通过 `CALL`、`CREATE PROCEDURE`、`CREATE FUNCTION`、`CREATE VIEW` 或查询视图来承载业务逻辑。
- 禁止把业务规则、兜底逻辑、展示拼接塞进 SQL；SQL 只负责必要的数据筛选、排序和字段读取，业务判断放到 Service。
- 禁止可能大规模锁表或诱发死锁的处理：不得无索引条件批量 `update/delete`，不得无边界扫描后持锁处理，不得长事务内循环更新或跨表不同顺序加锁；批量处理必须分批、命中索引、固定加锁顺序并缩短事务。

### 8. 输入校验
Controller 方法参数必须加 `@Valid`，DTO/Request 字段必须加 `@NotNull`、`@NotBlank`、`@Size` 等校验注解。

### 9. 异常处理
抛领域异常（如 `BizException`），附带上下文信息。禁止 `throw new RuntimeException()`、禁止空 catch 块。

```java
// ✅ throw new BizException("订单不存在, orderNo=" + orderNo);
// ❌ throw new RuntimeException("订单不存在");
// ❌ catch (Exception e) {}  // 空 catch
```

### 10. 日志规范
使用 SLF4J + 占位符。禁止字符串拼接、禁止打印密码/密钥。异常作为最后参数传入以保留堆栈。

```java
// ✅ log.info("处理订单, orderNo={}, status={}", orderNo, status);
// ✅ log.error("处理失败, orderNo={}", orderNo, e);
// ❌ log.info("处理订单, orderNo=" + orderNo);
```

### 11. 删除死代码
删除未使用的 import、私有字段、私有方法和已废弃的占位实现。

### 12. @Override 必须显式标注
任何重写方法都不省略 `@Override`。

### 13. 方法文档与关键注释
新增或修改的业务类、公共方法、受保护方法、重写方法、复杂私有方法必须写中文 JavaDoc：

- 说明方法功能、业务语义、关键前置条件。
- 使用 `@param` 说明每个参数的含义、必填性、关键取值约束。
- 非 `void` 方法使用 `@return` 说明返回值语义；可能抛出的业务异常使用 `@throws` 说明触发条件。
- 关键节点必须加中文行内注释：权限/租户/数据范围校验、状态流转、事务边界、外部调用、批量查询与组装、异常处理、复杂分支。
- 禁止无意义注释，例如“设置变量”“调用方法”；注释必须解释业务原因或流程意图。

### 14. SOLID 与适度设计
功能设计必须遵循 SOLID，但只能为真实需求服务：

- 单一职责：Controller 只做入参和上下文组装，Service 承载业务流程，Mapper 只做数据访问。
- 开闭原则：扩展点必须来自明确变化点，不为“未来可能”提前抽象。
- 依赖倒置：跨模块、外部系统、策略类依赖接口或既有适配层，普通内部协作优先沿用现有项目风格。
- 接口隔离：接口按调用场景拆分，不做大而全 Service/Manager。
- 里氏替换：实现类不得改变接口承诺的异常、返回值和状态语义。

### 15. 最小改动优先级与额外机制证据闸门（禁止过度设计和胡乱兜底）

实现优先级固定为：用户明确要求和验收标准 > 已确认的当前业务行为和同业务域最近似案例 > 权限、数据隔离、事务等必要正确性 > 使用最少文件、新类型和状态完成最小闭环 > 可选增强。通用安全经验不等于新增机制的授权。

- 新增 CAS、强制读主、重试、补偿、幂等、延迟队列、自定义线程池/监听容器、额外超时或数量/大小限制、默认值或降级路径前，必须指向以下至少一项：用户明确要求或验收标准、必须保持的当前行为、可复现的日志/测试/数据故障、同业务域最近似案例的既有机制。
- 只有“可能发生”不构成依据。同一个假设风险只允许选择一个有依据的最小机制，禁止叠加读主、重试、固定延迟、CAS 和补偿。如果风险由本次新设计制造，先简化或撤销该设计。
- 写生产代码前必须完成最小正确实现顺序：确认是代码问题；查找 1~2 个同业务域最近似案例；复用现有 helper/Service 方法/DTO/枚举/常量/测试基类、JDK/Spring/已安装依赖和现有字段/查询/状态流转/异常风格；bug 修复优先落在共享根因。
- 开始前在工作记录中列出：最近似案例与必需差异、预计修改模块与生产文件、预计新增类/配置/字段/消息/状态/外部依赖及其依据、明确不做的增强。需求要求“参考现有案例”时，没有完成差异表不得编码。
- 新建类前必须用 `rg --files` 和 `rg` 查找同类型、同业务域文件，按最近似案例确定目录和命名。禁止借需求顺手迁移/重命名无关公共类、修改无关模块 import 或重构旧流程。
- 模块职责必须与部署拓扑一致。普通 Spring `@Service` / 接口只能在同一个可部署产物内注入；跨独立应用调用必须使用项目既有 Feign、MQ 或 RPC 机制。新增或修改跨模块依赖注入时，必须核对实现类、Maven 依赖、`ComponentScan` 和最小 Spring Context 启动验证。
- 开始前记录改动预算。进入预期外业务模块、新增生产类超过预期 2 个以上、修改无直接调用关系或全局配置、出现第二套一致性/重试/补偿/状态机制，或实际生产代码明显超出方案时，必须暂停并分为“需求必需、技术必需、可选增强”；可选增强默认删除。
- 提交前做删除式评审：对每个新增生产类、配置、字段、状态、常量和复杂中间变量回答“删除它后，哪一条明确需求、现有行为、测试或已证实故障会失败？”无法回答的代码及对应测试必须删除；已写测试不能作为保留理由。
- 最小改动不得削掉入参校验、权限/数据范围、异常语义、事务边界、必要测试和中文 JavaDoc。

---

## Java 推荐规则 (SHOULD)

### 16. 命名规范
- 类/Record：PascalCase
- 方法/字段：camelCase
- 常量：UPPER_SNAKE_CASE
- 布尔字段：is/has/can/should 前缀

### 17. 优先 immutability
DTO/VO/Request/Response 优先使用 `record`。Service 依赖字段用 `final`。

### 18. Optional 链式
用 `map/flatMap/orElseThrow`，禁止 `isPresent() + get()`。禁止 Optional 作为方法参数。

### 19. Swagger 注释完整
请求/响应对象、字段、枚举值必须有 `@Schema(description = "中文说明")`。

### 20. 多表 SQL 加表别名
多表查询、更新、删除时，对操作列加表别名限定，避免歧义。

### 21. Controller 规范
- 请求路径用 RESTful + kebab-case（`/order-settlement`）
- 仅允许 GET/POST
- Controller 只负责参数接收和组装，业务逻辑必须放 Service

### 22. VO 枚举码同步返回展示字段
当 VO 返回状态码时，必须同时返回 `statusName` 等展示字段。

### 23. 魔法值收敛到枚举
业务状态、类型、来源等优先使用语义化枚举，而非零散常量。

---

## MyBatis 规范

- Mapper 方法命名：`selectByXxx`、`updateXxxById`、`pageByCondition`、`insert`、`deleteById`
- 多参数必须用 `@Param` 注解
- 禁止 `Map<String, Object>` 作为 Mapper 方法参数
- 分页方法返回 `IPage<XxxVO>`，参数包含 `Page<XxxVO> page`
- 禁止用一条大 SQL 承载复杂业务流程；超过两表关联、函数处理、视图/存储过程依赖必须退回设计拆分

---

## Merge 冲突解决规范

- 解决冲突不能只确认“类还在、方法还在、能编译”。必须确认方法依赖的运行期元数据、注解、XML、配置、字段注入、权限控制等没有被冲掉。
- 冲突文件在 `git add` 前必须双边对比 ours/theirs，优先使用 `git show :2:<file>` 和 `git show :3:<file>` 查看双方原始内容，确认双方新增或已有业务逻辑都被保留。
- Mapper 冲突必须把“方法声明 + MyBatis SQL 绑定”当成一个整体检查：方法上要有 `@Select/@Update/@Insert/@Delete`，或 XML 中要有同名 `<select>/<update>/<insert>/<delete id="...">`。
- DAO 接口、DAO 实现、Mapper 方法三层要一起检查；旧方法如果仍被 DAO 暴露，即使不是当前主路径，也必须保留对应 SQL 绑定。
- 相邻方法冲突最容易误删注解、JavaDoc、事务注解、权限注解、缓存注解、参数校验和字段注入；这些内容都算方法或字段的一部分，不能只保留签名。
- 冲突涉及 Controller / Service / Feign / MQ / Job / DTO / VO 时，必须重点检查权限注解、`@Valid`、参数注解、`@Transactional`、构造器注入参数、外部调用、消息发送、定时任务注册、Swagger 注解和枚举展示字段是否丢失。
- `mvn compile` 不能作为唯一验收。冲突解决后必须按冲突文件做 targeted grep、Mapper statement 绑定检查或相关接口/任务/Service 测试，覆盖低频保留路径。

---

## TDD 测试规范

- 每个测试方法必须有 `@DisplayName("中文场景描述")`
- 方法命名：`方法名_should预期行为_when条件`
- 断言使用 AssertJ：`assertThat(x).isEqualTo(y)`，不用 JUnit `assertEquals`
- 三段式注释：`【准备数据】` `【执行操作】` `【验证结果】`
- 覆盖边界：空参数、不存在记录、分页边界、状态不匹配

---

## 安全基线

- 查询必须限定数据权限（如 `companyNo`），防止越权
- 敏感接口必须加权限注解（`@PreAuthorize`）
- 日志不得打印密码、身份证、手机号等敏感信息
- 禁止代码中硬编码密码/密钥/Token（`grep -rn "password\|secret\|token" src/main/java/`）
- 只有存在两个及以上真实并发写入者，且更新依赖旧状态时才使用 CAS（乐观锁）。新增 CAS 前必须写明竞争写入者、允许的状态迁移和 CAS 失败后的业务语义；无并发证据的状态更新禁止自行新增 `expectedStatus`、版本号或 CAS Mapper。

# Team Memory RBAC

面向多用户、多 Agent 的共享记忆系统。云端保存可审计的权威历史，本地提供受权限约束的低延迟工作视图。

## Language

**Cloud Memory Authority**:
保存完整 commit/operation 历史并决定共享 active state 的唯一系统权威源。
_Avoid_: 云端缓存、远程副本

**Team Memory Service**:
接收 Agent 和客户端请求的业务入口；它使用 Cloud Memory Authority 做授权、写入、检索和同步编排，但自身不是权威源。
_Avoid_: 存储节点、云端副本、第二权威源

**Logical Cloud Authority**:
业务语义上的单一 Cloud Memory Authority；物理实现可以是单实例或 CP 分布式系统，但对冲突、权限和提交顺序表现为一个权威源。
_Avoid_: 多主最终一致副本、每台服务器一个权威源

**Authorized Snapshot**:
某个 subject 在特定 root、branch 和 TaskScope 下有权读取的云端 active state 本地快照。
_Avoid_: 本地权威库、完整镜像

**Pending Operation**:
已在本地接受并进入本地查询视图、但尚未被 Cloud Memory Authority 接受为目标 branch commit 的操作。
_Avoid_: 本地 commit、已同步修改

**Pending Overlay**:
由 Pending Operations 投影出的本地查询层；在冲突未裁决时，它会在本机遮蔽 Authorized Snapshot 的相同位置。
_Avoid_: 第二权威源、本地 branch head

**Conflict Key**:
标识操作所修改逻辑位置的稳定键，用于判定并发 commit 是否触碰同一位置。
_Avoid_: MemoryEntityBranch ID、数据库行锁键

**Memory Conflict**:
云端检测到两个不等价 commit 修改相同 Conflict Key 后保存的未裁决分歧记录。
_Avoid_: contradicts relation、自动 merge

**Conflict Branch**:
Cloud Memory Authority 为保存冲突来稿而创建、但不改变目标 branch active head 的系统分支。
_Avoid_: 本地 pending queue

**Resolution Commit**:
管理员对一个或多个 Memory Conflicts 作出 keep target、take incoming 或 manual merge 后创建的权威 commit。
_Avoid_: 覆盖写、删除冲突记录

**Commit Watermark**:
本地已应用的云端权威变更位置；其顺序由云端分配，不依赖客户端时间。
_Avoid_: lastSyncedAt

**Permission Watermark**:
标识 subject 在 root 下授权状态版本的云端游标；变化会使旧 Authorized Snapshot 失效。
_Avoid_: 权限缓存时间

**CAS-first Visibility**:
引用原始资源内容的权威提交只有在对应 CAS object 已按 contentHash 可读后才能对读路径可见。
_Avoid_: SQL 先可见、metadata 指向未同步文件

**Principal Context**:
由受信任 transport/session 解析出的用户、Agent、delegation、root 和 TaskScope 身份上下文。
_Avoid_: prompt 中的用户信息、模型填写的 userId

# Profile README 运维手册（OPS）

本仓库的 profile README 曾经反复出现"图片丢失"，根因是**依赖了陌生人部署的免费公共服务**。
本文档记录现在的架构、每张图的来源与死因分类、以及出问题时的处理方法。

## 一、为什么会定期死（根因分类）

| # | 死因 | 机制 | 现状 |
|---|------|------|------|
| 1 | 免费公共实例消失 | `*.vercel.app` / `*.herokuapp.com` 是**别人**部署的免费实例。维护者额度用完、被计费、弃坑，实例随时消失（如 activity-graph 的 `402 Payment Required / DEPLOYMENT_DISABLED`；Heroku 2022 年砍掉免费层） | 已全部替换为仓库内自生成 |
| 2 | 上游 Action breaking change | 第三方 Action 用 `@latest` 不锁版本，上游一改行为定时任务就悄悄变红 | metrics 已锁 `@v3.34`，其余已锁大版本或 tag |
| 3 | 静默过期 | 定时 workflow 失败 / 被 GitHub 降权延迟，没人发现；仓库 **60 天无提交**时 GitHub 会自动停用全部定时任务 | 健康检查每日巡检 + 自动重跑 + issue 告警 |
| 4 | 自建反代 | `trophy.ryglcloud.net` 绑定自己的服务器存活 | 保留，但已纳入每日体检监控 |
| 5 | camo 缓存 | GitHub 通过 camo 代理缓存图片，改了图浏览器可能还显示旧的 | 刷新缓存见下文 |

## 二、现在的架构（三层防线）

```
第 1 层  自生成（消除外部依赖）
  scripts/generate-readme-stats.mjs  ← GitHub API + GraphQL，Actions 每日跑
    产出 github-readme-stats/{profile-stats, top-langs, top-repositories,
    recent-repos, top-starred-repos, streak}.svg
  .github/workflows/{metrics,snake,contrib}.yml ← 第三方 Action 生成
    产出 github-metrics/*.svg、profile-snake-contrib/*.svg、profile-3d-contrib/*.svg

第 2 层  自愈（Profile Health Check，每日 09:00 UTC）
  scripts/health-check.mjs
    a. 抓取 README.md 全部图片 URL（HTML src/srcset + Markdown 图片，6 并发），验证 200 + 图片内容，
       并做「错误占位卡」内容嗅探——自托管卡片服务出错时返回的是 HTTP 200 + 错误 SVG，
       只看状态码会漏检（嗅探标记：Something went wrong / not whitelisted / No GitHub API
       tokens found / Resource not accessible 等）
    b. 检查 4 个生成 workflow 最近 48h 内是否有成功运行（单文件 404 不炸整体；
       queued/in_progress 超 6h 视为卡死）
    c. 坏了/过期 → 自动 workflow_dispatch 重跑对应生成器（同一 workflow 20h 冷却，
       确定性失败只告警不无限重跑）
    d. 修不了的（外部服务死）→ 维护唯一 issue「🚨 Profile README health check failed」
       （更新正文而非追加评论）；有未修复故障时 Actions 退出码为红

第 3 层  告警
  issue 存在 = 有问题；全部恢复后脚本自动关闭该 issue 并评论
  想更主动：把 issue 通知转发到邮箱（GitHub 默认会发邮件）
```

仍依赖的外部服务（可接受项）：
- `img.shields.io` 静态徽章 —— 极稳定，且仅剩文字样式，无个性化数据
- `trophy.ryglcloud.net` —— 自建反代，自己的基础设施
- `ghstats.hylouis.fyi` / `streak.hylouis.fyi` —— 自托管卡片服务（见下节）

## 二点五、自托管漂亮卡片层（Colocrossing，已部署待激活）

**架构**：Colocrossing 机器（Ubuntu 24.04，107.172.252.169）上的 `/opt/profile-cards/`，
三个容器（`docker compose`）：

| 容器 | 内容 | 端口 |
|---|---|---|
| `profile-cards-ghstats` | anuraghazra/github-readme-stats（源码构建，含 server.mjs Express 包装） | 仅内网 :9000 |
| `profile-cards-streak` | DenverCoder1/github-readme-streak-stats（源码构建） | 仅内网 :80 |
| `profile-cards-tunnel` | cloudflared（tunnel `profile-cards`，ID `fa44736e-732a-494f-b56b-9dc8b68bf775`） | 出站-only |

- 对外通过 Cloudflare Tunnel 暴露：`ghstats.hylouis.fyi`、`streak.hylouis.fyi`（DNS 由
  本机 `~/.cloudflared/cert.pem` 创建，CNAME 已自动加好）
- **未开放任何新入站端口**，不占用 payment-caddy；credentials.json 600 root-only
- 已配 `WHITELIST=Hylouis233`：别人无法通过该端点烧你的 API 配额

**✅ 已激活（2026-09-20）**：PAT 已配置在服务器 `/opt/profile-cards/.env`（600 权限），
两个服务均验证通过。README 的 Stats/Top-Langs/Streak 三张图已切换到自托管版（onedark 主题）。

**⚠️ 重要：本地补丁**。fine-grained PAT 无法访问 GraphQL 的 `stargazers { totalCount }`
连接字段（GitHub 权限模型限制，报 `Resource not accessible by personal access token`），
已将 `/opt/profile-cards/src/github-readme-stats/src/fetchers/stats.js` 里的查询改用等价的
标量字段 `stargazerCount`（共 3 处：查询、`repoNodesWithStars` 过滤、`totalStars` 求和）。
**升级上游代码（`git pull`）时必须重新应用此补丁**，否则 stats 卡会重新报错。

**日常运维**：
- 重启：`cd /opt/profile-cards && docker compose up -d`；日志：`docker logs profile-cards-ghstats`
- 换主题：改 README 里 URL 的 `theme=` 参数（两服务共享主题库：onedark/tokyonight/dracola…）
- 回退：把 README 里 `ghstats.hylouis.fyi` / `streak.hylouis.fyi` 的 URL 改回
  `github-readme-stats/*.svg` 自生成版即可（生成器每天照常运行，永远是热备）
- token 过期（建 token 时选的期限到期）：重新生成 PAT 后更新 `.env` 并 `docker compose up -d`

**历史排障记录**（供未来排查参考）：
- ghcr.io 在 Colocrossing 拉取被拒 → 全部改源码构建（`src/` 下两个 clone）
- streak-stats 新版是 Apache/PHP 镜像，容器内端口是 **80**（不是文档的 8080）
- cloudflared 容器默认非 root 用户读不了 600 的配置 → compose 里 `user: root`
- 两个卡片项目均**强制要求 PAT**（无 token 渲染错误卡），token 统一从 `.env` 的 `PAT_1` 注入
- stats 卡曾报 `No GitHub API tokens found` / `Resource not accessible...`：前者是缺 PAT，
  后者即上述 stargazers 字段补丁问题

**架构**：Colocrossing 机器（Ubuntu 24.04，107.172.252.169）上的 `/opt/profile-cards/`，
三个容器（`docker compose`）：

## 三、各图速查表

| README 里的图 | 来源 | 生成 workflow | 死了怎么自动处理 |
|---|---|---|---|
| **Stats / Top-Langs**（漂亮卡） | `ghstats.hylouis.fyi`（自托管） | 服务器容器（常驻） | **无法自动修**，体检开 issue；回退改 URL 即可 |
| **Streak 连击**（漂亮卡） | `streak.hylouis.fyi`（自托管） | 服务器容器（常驻） | **无法自动修**，体检开 issue；回退改 URL 即可 |
| Featured Repos / Recent Repos（自生成热备 + Stats/Streak/Langs 的回退图） | `github-readme-stats/*.svg` | `readme-stats.yml`（每日 02:27 UTC） | 健康检查重跑 |
| Metrics 三联图 | `github-metrics/*.svg` | `metrics.yml`（每日 00:00 UTC） | 健康检查重跑 |
| Contribution Snake | `profile-snake-contrib/*.svg` | `snake.yml`（每日 02:00 UTC） | 健康检查重跑 |
| 3D Contribution | `profile-3d-contrib/*.svg` | `contrib.yml`（每日 01:00 UTC） | 健康检查重跑 |
| Trophies | `trophy.ryglcloud.net` | 自建反代 | **无法自动修**，会开 issue 提醒 |
| 各类徽章 | `img.shields.io` | 无 | 极少坏，会开 issue 提醒 |

## 四、运行手册

**收到「🚨 Profile README health check failed」issue 时：**
1. 看 issue 里列出的失败项：
   - `image: ... raw.githubusercontent.com/...` → 健康检查已尝试重跑生成器，等 10 分钟手动再跑一次 Health Check（Actions → Profile Health Check → Run workflow）确认恢复
   - `image: ... trophy.ryglcloud.net` → 自己的服务器/反代挂了，检查 DNS、证书、上游
   - `image: ... img.shields.io` → shields 抽风，通常自动恢复
   - `workflow: xxx.yml: last run failure ...` → 点链接看具体日志
2. 修复后无需手动关 issue —— 下次体检全绿会自动关闭

**改了图但浏览器还显示旧图（camo 缓存）：**
硬刷新（Cmd+Shift+R）；仍旧的等 camo TTL 自然过期即可，不影响别人首次加载。

**手动触发任一环节：**
所有 workflow 都带 `workflow_dispatch`，Actions 页面直接 Run workflow，或：
```bash
gh workflow run health-check.yml  -r main   # 体检
gh workflow run readme-stats.yml -r main   # 重新生成统计卡
```

**升级被锁定的 Action：**
`metrics.yml` 锁在 `lowlighter/metrics@v3.34`。升级前先看
<https://github.com/lowlighter/metrics/releases>，改 tag 后手动 Run 一次确认输出正常。

## 五、已知边界

- Streak 卡窗口为**最近一年**（GraphQL contributionCalendar 上限），与原 streak-stats 服务口径一致
- `repositories.pinned.svg` 显示 pinned 数上限为 3（metrics 的 `plugin_repositories_pinned` 上限）
- 定时任务靠生成器的每日提交维持仓库活跃度，从而避免 GitHub 的「60 天无活动自动停用定时任务」；若长期停用所有 workflow 后需到 Actions 页面手动 Enable
- `waka.yml` 是故意保留的手动占位，不参与体检

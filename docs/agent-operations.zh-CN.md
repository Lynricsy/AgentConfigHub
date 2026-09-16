# 在 UltraServerUS 上管理 AgentConfigHub 配置

供获得用户授权的 agent 使用：为指定配置组添加文件、修改配置、管理密钥与共享资源，并在用户要求时发布、验证或回滚。日常修改走管理 API，不修改 SQLite、加密 Blob 文件或客户端本地配置来冒充服务端更新。

## 1. 开始前：确定目标与授权范围

先把用户要求落实到四项：**配置组 slug、Agent ID、目标文件或资源、是否发布**。例如“给 main 的 omp 增加 MCP 并让客户端可拉取”包含发布；“只改草稿”不包含发布。目标无法从上下文唯一确定时才询问，不能擅自选 `main`。

2026-09-16 只读核对的部署位置如下；执行新任务时仍须检查现场，不能把端口或镜像标签当作永久不变的事实。

| 项目 | 已核对的值 |
| --- | --- |
| OneSSH 主机名 | `UltraServerUS` |
| 部署目录 | `/root/Service/AgentConfigHub` |
| 公网入口及请求 Origin | `https://agent-config-hub.ling.plus` |
| Compose 服务 | `agent-config-hub` |
| 宿主机回环端口 | `127.0.0.1:35305` → 容器 `3000` |
| 镜像 | `ghcr.io/lynricsy/agentconfighub:edge` |
| 核对时的镜像 revision | `492eb8579697f360a02a7ccdfc15d623ff7ab629` |

使用 OneSSH 时先调用 `hosts_list`，确认名称；再用 `memory_recall` 查询该主机的 AgentConfigHub 经验。只读巡检可在上述目录执行 `docker compose ps --format json`，并请求 `GET /api/v1/health`。本次实际健康响应为 `{"status":"ok"}`。普通配置修改不需要重启、更新镜像或改 `.env`。

必须遵守：

- **管理权限与拉取权限分开。** 管理 API 使用管理员 session cookie；设备令牌和 automation token 只用于 `/api/v1/cli/` 拉取接口，不能编辑配置。
- **保存不等于发布。** Blob 上传、草稿保存、凭据轮换均不会更新已有 Release。客户端只拉取已发布内容。
- **发布以整个配置组为边界。** 只改了 OMP 的一个文件，也会发布该组所有已启用 Agent 的当前草稿、资源和密钥绑定。发现无关未发布改动时，先向用户说明并确定处理范围，不能悄悄夹带发布。
- **同组修改串行。** 使用读取时获得的版本作为 `If-Match`；不要并行写同一配置组，也不要遇到冲突后只刷新版本就覆盖。
- **不输出秘密。** 管理员密码、session cookie、密钥、拉取令牌、渲染后的敏感文件正文不得进入文档、命令参数、工具审计日志、Git 或最终回复。只报告 ID、版本、目标路径和验证结果。
- **SSH root 不代替应用授权。** 没有管理员登录能力时，不插入 session 数据库记录、不重置管理员密码、不读取主密钥绕过鉴权。先完成可做的只读核对，再请用户提供安全登录方式。

## 2. 建立管理会话并定位指定配置

### 2.1 登录

优先复用用户明确授权的已登录浏览器，在站点同源页面调用 API；不要导出 cookie 到聊天。也可以使用下方 Python 3 标准库示例，在可信、无输入录屏的交互终端中隐藏输入管理员密码，cookie 只保留在内存。

下面的请求函数及后续 Python 示例需要在**同一个 Python 会话**中运行。它们是按任务挑选的操作片段，不是一份应从头到尾自动执行的脚本。没有安全交互输入能力的 agent 应改用授权浏览器，不要把 `getpass` 改成硬编码密码。请求函数不自动重试；HTTP 错误只显示状态、错误码和请求 ID，不转储响应正文。

先定义请求函数，此块本身不执行写入：

```python
import getpass
import hashlib
import http.cookiejar
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import HTTPCookieProcessor, Request, build_opener

BASE = "https://agent-config-hub.ling.plus"
cookies = http.cookiejar.CookieJar()
client = build_opener(HTTPCookieProcessor(cookies))


def api(method, path, body=None, *, revision=None, raw=None,
        media_type="application/octet-stream", binary=False, token=None):
    headers = {"Origin": BASE, "Accept": "application/json"}
    data = raw
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif raw is not None:
        headers["Content-Type"] = media_type
    if revision is not None:
        headers["If-Match"] = f'"{revision}"'
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(BASE + path, data=data, headers=headers, method=method)
    try:
        with client.open(request, timeout=60) as response:
            content = response.read()
    except HTTPError as error:
        try:
            detail = json.loads(error.read()).get("error", {})
        except (ValueError, AttributeError):
            detail = {}
        raise RuntimeError(
            f"HTTP {error.code}: {detail.get('code', 'UNKNOWN')}; "
            f"requestId={detail.get('requestId', 'unknown')}"
        ) from None
    if binary:
        return content
    return json.loads(content) if content else None
```

确认健康后登录。`POST /api/v1/login` 的请求体只有 `password`，成功为 HTTP 204，响应设置 `agch_session`；随后 `/session` 应返回 `authenticated: true`。

```python
assert api("GET", "/api/v1/health")["status"] == "ok"
api("POST", "/api/v1/login", {"password": getpass.getpass("管理员密码：")})
assert api("GET", "/api/v1/session")["authenticated"] is True
```

登录和所有写请求必须携带 `Origin: https://agent-config-hub.ling.plus`。优先访问公网 HTTPS，避免回环 HTTP 与 Secure cookie 行为差异；不能通过省略 Origin 绕过检查。

### 2.2 用 slug 找 ID，再读完整草稿

下例在提示时输入用户指定的 slug；不要将历史日志中的配置组 ID、草稿版本或 Release ID 写死。

```python
slug = input("用户指定的配置组 slug：").strip()
sets = api("GET", "/api/v1/config-sets")
matches = [item for item in sets if item["slug"] == slug]
if len(matches) != 1:
    raise RuntimeError("未唯一匹配配置组；停止并核对目标")
config_id = matches[0]["id"]
config_path = f"/api/v1/config-sets/{quote(config_id, safe='')}"
snapshot = api("GET", config_path)
revision = snapshot["configSet"]["draftRevision"]
previous_release_id = snapshot["configSet"]["currentReleaseId"]
adapters = api("GET", "/api/v1/adapters")
```

确认 `snapshot.configSet.enabledAgents` 包含目标 Agent。详情还返回 `files`、`overlays`、`selectedResources`、`secretSlots`；文件内容需用文件条目的 `blobSha256` 请求 `GET /api/v1/blobs/:sha256`，不能只看文件名就覆盖。

详情响应的 `ETag` 是带双引号的草稿数字版本，例如 `"12"`。后续写草稿传相同格式的 `If-Match`；成功响应的 `{revision}` 是下一次写入所用版本。不要混用配置组数字版本、资源 `revisionId` 和 Release ID。

如果 `draftRevision` 与 `currentReleaseRevision` 不同，说明存在未发布状态（首次发布的后者可能为 `null`）。即使相同，也要核对目标文件和资源；版本比较不是内容差异审查。发布接口没有“只发布某个文件”的参数，也没有草稿预发布 diff API。先查看 Web 草稿、已有 Release 信息和所需文件，再决定是否可发布。

## 3. 给指定配置添加文件

### 3.1 确定逻辑目标，不填写服务器绝对路径

`target` 是 `{root, relativePath}`，例如 OMP 的 `{"root":"omp-home","relativePath":"mcp.json"}`；不是 `/root/.omp/agent/mcp.json`。默认客户端根目录如下，客户端可自行覆盖：

| Agent ID | root | 默认客户端位置 |
| --- | --- | --- |
| `claude-code` | `claude-home` | `~/.claude` |
| `codex` | `codex-home`、`agents-home` | `~/.codex`、`~/.agents` |
| `opencode` | `opencode-home` | `~/.config/opencode` |
| `pi` | `pi-home` | `~/.pi/agent` |
| `omp` | `omp-home` | `~/.omp/agent` |
| `grok` | `grok-home` | `~/.grok` |

以实时 `GET /api/v1/adapters` 的 `roots`、`surfaces` 为准。路径只能使用 `/`，不能包含绝对路径、`..`、空段或 Windows 非法名称。

OMP 常用受管文件包括 `.env`、`config.yml`、`models.yml`、`mcp.json`、`keybindings.yml`/`.json`，以及 `rules/`、`role-prompts/`、`commands/`、`skills/`、`extensions/` 等目录下的文件。`agent.db`、会话、缓存、`node_modules` 等运行时状态不能上传。标有 `reserved: true` 的文件由共享资源生成；OMP 的 `AGENTS.md` 要按第 6 节编辑，不能作为普通文件上传。

OMP adapter revision 5 起增加根目录 `omp-notify.json`，按 JSON 校验，Telegram 凭据可使用第 5 节的完整标量 secret 占位符。该版本对应 CLI `0.2.3`；操作前仍以线上 `/api/v1/adapters` 为准，旧部署不接受此路径。CLI 要求适配器 revision 精确匹配，应先准备新版 CLI、部署新版服务端并发布新 Release，再让客户端拉取；不要让新版 CLI 直接拉取旧 OMP revision 4 的 Release。

### 3.2 校验、上传 Blob、创建文件

以下例子只适用于用户要求**为已有 OMP 配置新增 UTF-8 文本文件**。先准备已审阅、无明文密钥的本地文件；运行时输入目标相对路径、该本地文件的路径和 MIME 类型。JSON 用 `application/json`，YAML 用 `application/yaml`，TOML 用 `application/toml`，Markdown 用 `text/markdown`，`.env` 用 `text/plain`。

```python
agent_id = "omp"
root = "omp-home"
relative_path = input("新增文件的目标相对路径：").strip()
candidate_path = Path(input("已审阅的本地 UTF-8 文件路径：").strip())
media_type = input("文件 MIME 类型：").strip()
target = {"root": root, "relativePath": relative_path}
assert agent_id in snapshot["configSet"]["enabledAgents"]
assert not any(
    file["agentId"] == agent_id and file["root"] == root
    and file["relativePath"] == relative_path
    for file in snapshot["files"]
), "目标已存在；应进入编辑流程，不能当作新增覆盖"
content = candidate_path.read_bytes()
text = content.decode("utf-8")
validation = api("POST", "/api/v1/validate-file", {
    "agentId": agent_id, "target": target, "mediaType": media_type,
    "text": text, "executable": False,
})
if any(item["severity"] == "error" for item in validation["diagnostics"]):
    raise RuntimeError("存在阻断诊断；先检查诊断再继续")
```

在受控环境检查 `validation.diagnostics` 中每条 warning；不要把含内容片段的诊断直接贴进任务日志。`validate-file` 只做单文件校验和内联秘密扫描，**不保证密钥槽已绑定、资源无碰撞或整个配置组可发布**；`reserved` 目标也仍不能通过普通文件创建。该接口文本上限 2 MiB。

完成审查后上传原始字节，再执行只创建操作：

```python
blob = api("PUT", "/api/v1/blobs", raw=content, media_type=media_type)
assert blob["sha256"] == hashlib.sha256(content).hexdigest()
file_body = {
    "target": target, "blobSha256": blob["sha256"],
    "mediaType": media_type, "utf8": True, "executable": False,
}
result = api("POST", f"{config_path}/configs/{agent_id}/files",
             file_body, revision=revision)
revision = result["revision"]
snapshot = api("GET", config_path)
assert any(
    file["agentId"] == agent_id and file["root"] == root
    and file["relativePath"] == relative_path
    and file["blobSha256"] == blob["sha256"]
    for file in snapshot["files"]
)
```

成功表现：Blob 上传和新建均返回 201；草稿文件列表出现准确的 Agent、root、路径和哈希。Blob 上传本身不增加草稿版本；新建会增加。若文件已存在，创建接口返回 `409 DRAFT_FILE_ALREADY_EXISTS`，不要自动切换为覆盖。

二进制文件不使用上述 UTF-8 校验示例；只有目标适配器允许时才上传，登记 `utf8: false` 和正确 MIME 类型。脚本是否 `executable: true` 由用户意图与客户端用途决定，不能一律启用。

## 4. 修改、重命名或删除已有配置文件

### 修改文件

1. 重新读取配置组详情，保留这次读取的 `draftRevision`。按 `(agentId, root, relativePath)` 唯一定位文件，保存旧 `blobSha256` 和文件元数据作为恢复依据。
2. `GET /api/v1/blobs/:sha256` 取得原始字节。在内存或受限临时文件中只改用户要求的内容；JSONC、YAML、TOML 避免无关重排、丢注释。不能拿空对象重新生成整个配置覆盖已有内容。
3. 按第 3 节校验候选内容、审查诊断、上传新 Blob。
4. 调用 `PUT /api/v1/config-sets/:configSetId/files`，传第 3 节的 `file_body` **另加 `agentId`**，并带读取时的 `If-Match`。此接口是 upsert；必须先验证目标确实存在，防止拼错路径意外新增。
5. 读取新详情和新 Blob，比对哈希及语义差异；确认未改其他目标。保存成功只说明草稿更新，如需客户端生效再按第 7 节发布。

第 4 步的 Python 请求形态如下；前提是已按以上步骤重新取得 `file_body`、`revision`、`agent_id`，不能直接复用其他任务的变量：

```python
result = api("PUT", f"{config_path}/files",
             {**file_body, "agentId": agent_id}, revision=revision)
revision = result["revision"]
```

如果内容和元数据完全相同，直接报告无需修改，不制造无意义修订。单个文件的草稿恢复可把旧 Blob 重新登记到原目标；必须使用最新已审阅的草稿版本，且 Blob 仍需存在。这比回滚整个配置组范围小。

### 重命名文件

没有 rename API。先校验新路径，再以同一 Blob 在新路径执行只创建，成功后使用返回的新版本删除旧路径；两步完成并验证后再发布。它们不是一个原子事务，中途失败要读回状态，不能声称重命名已完成。大小写改名也要避免最终发布中的路径碰撞。

### 删除文件

获得删除授权后，以 `DELETE /api/v1/config-sets/:configSetId/files` 发送 `{"agentId":"omp","target":{"root":"omp-home","relativePath":"rules/example.md"}}`，带当前 `If-Match`。这是请求体形态示例，路径必须替换为已核对的真实目标。

成功后文件应从草稿列表消失；旧 Release 不变。发布后的删除会在客户端下一次 pull 时涉及受管文件删除保护，不能为通过校验擅自启用 `--force-remove-modified`。

## 5. 增加密钥、绑定槽位与轮换

先区分三种东西：业务 API 密钥存入 **Credential**；管理员密码用于登录；automation token 用于拉取。这三者不可混用。

### 5.1 将真实密钥保存为加密凭据

`GET /api/v1/credentials` 返回 ID、label、provider、revision、maskedValue、referenceCount，不返回真实值。先检查是否已有合适凭据；不能因为列表里是掩码就拿掩码作为新密钥。

确认要新建时，在可信交互终端执行；`label` 和 `provider` 由任务确定，密钥隐藏输入：

```python
credential = api("POST", "/api/v1/credentials", {
    "label": input("凭据名称：").strip(),
    "provider": input("提供方名称：").strip(),
    "value": getpass.getpass("完整密钥值（不会显示）："),
})
credential_id = credential["id"]
```

返回 201，随后列表应出现新凭据 ID 和 revision。通常不需要调用 reveal；确需查看时是 `POST /api/v1/credentials/:credentialId/reveal`，需要再次提交管理员 `password`，响应含明文，绝不能输出到工具日志。

### 5.2 在文件里使用完整标量占位符

槽名必须匹配 `[A-Z][A-Z0-9_]{0,63}`，例如 `SERVICE_API_KEY`。只支持 JSON、JSONC、YAML、TOML 和 dotenv 的**完整字符串值**；不支持 Markdown、普通文本或字符串内拼接。

以下是待合并到 OMP `mcp.json` 的结构示例，不是可直接上线的真实服务。必须把示例名称与 `https://mcp.example.com/mcp` 换为用户提供的服务信息，并保留现有其他 MCP 项：

```json
{
  "mcpServers": {
    "example-service": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "{{secret:EXAMPLE_MCP_AUTHORIZATION}}"
      }
    }
  }
}
```

若认证头需要 `Bearer ` 前缀，Credential 的值保存**完整的 `Bearer ` 加密钥**，文件中仍只放完整占位符。`"Bearer {{secret:KEY}}"` 或 URL 中嵌入占位符均不合法。普通 `apiKey` 字段通常绑定原始密钥，不额外加前缀。

根目录 `.env` 同样可托管，例如 `SERVICE_API_KEY="{{secret:SERVICE_API_KEY}}"`。不要假设 Agent 会自动读取任意 `.env`；应用如何使用该变量须另行核对。

### 5.3 绑定到指定配置组或指定 Agent

先重新读配置组详情，审查是否发生并发变化，再取版本。以下变量 `credential_id` 来自新建结果或已核对的现有凭据 ID；输入槽名后绑定为配置组默认值：

```python
snapshot = api("GET", config_path)
revision = snapshot["configSet"]["draftRevision"]
slot_name = input("配置文件使用的密钥槽名：").strip()
slot_path = f"{config_path}/secret-slots/{quote(slot_name, safe='')}"
result = api("PUT", slot_path, {"credentialId": credential_id},
             revision=revision)
revision = result["revision"]
```

如只授权 OMP 使用这条凭据，不要执行上面的默认绑定。改为先向同一 `slot_path` PUT `{"credentialId":null}` 创建无默认凭据的槽（**仅在槽尚不存在时**），再用返回的新版本向 `slot_path + "/agents/omp"` PUT `{"credentialId": credential_id}`。已有槽保留其原默认绑定，只新增或修改 OMP override。

Agent override 优先于默认绑定。向 `/agents/omp` PUT `{"credentialId":null}` 是删除 override、恢复使用默认值，**不是禁止该 Agent 使用密钥**；向默认槽 PUT `null` 则清空默认凭据但保留槽。修改后 GET `.../secret-slots`，核对 `slots` 和 `overrides`。

把包含占位符的文件按第 3/4 节保存，然后发布。仅创建 Credential 或绑定槽，不会自动在配置文件里添加 `apiKey` 或 MCP 条目。凭据、槽、文件是多步操作，不是事务；失败时检查已经成功的步骤再继续。

### 5.4 轮换密钥

1. GET 凭据列表并检查 `referenceCount`。遍历配置组详情中的槽与 override，确定影响哪些组/Agent；计数不是完整影响列表。
2. 如用户只要求一个配置使用新密钥，而旧凭据仍被其他配置使用，新建 Credential 并改目标绑定，不要轮换共享凭据。
3. 对确认要轮换的 ID 调用 `POST /api/v1/credentials/:credentialId/rotate`，请求体为 `{"value": 新的完整密钥值}`；秘密仍通过安全输入获得。
4. 轮换会增加凭据 revision，并增加所有引用配置组的草稿版本。重新读取受影响组，不能继续用轮换前的 `If-Match`。已有 Release 仍冻结旧密钥，需要分别发布用户授权的配置组并验证客户端。
5. 确认新版本工作后，按用户授权在密钥提供方撤销旧值；Hub 内轮换不会替你撤销外部密钥。

回滚过的配置可能固定了历史凭据 revision。轮换后若仍需要切到最新值，显式重新 PUT 目标默认绑定或 override（可以是相同 credentialId）解除该绑定的历史固定，再发布并验证。当前管理 API 没有凭据删除接口，不要发明 `DELETE /credentials/:id` 或直接删表。

## 6. 编辑指令、增加 Skill 或创建配置

### 只修改某个配置的 Agent 指令

OMP 的 `AGENTS.md`、Claude Code 的 `CLAUDE.md` 等保留目标由共享 instruction 与 Agent overlay 生成。对仅限一个配置组/Agent 的追加内容：

1. 从配置组详情读取当前 `overlays`，保留已有内容并形成完整的新 Markdown。
2. 带草稿 `If-Match`，向 `PUT /api/v1/config-sets/:configSetId/overlays/:agentId` 发送 `{"markdown": 完整的新内容}`。这是覆盖整个 overlay，不是追加 API。
3. GET 详情确认该 Agent overlay；发布后检查生成的指令文件。共享指令按资源顺序拼接，overlay 在其后。

删除 overlay 使用同一路径 DELETE，不传业务请求体，仍带 `If-Match`。删除 overlay 不会删除共享 instruction；不要用上传 `AGENTS.md` 来覆盖生成机制。

### 跨配置复用 instruction 或 Skill

1. `GET /api/v1/resources` 获取 `resources` 与 `files`。先确认资源是不是共享：修改资源会增加所有引用配置组的草稿版本；只改一处时优先 overlay、独立资源或原生文件。
2. 按第 3 节方式上传各文件 Blob。创建资源使用 `POST /api/v1/resources`，请求体含 `kind`（`instruction` 或 `skill`）、便携 `slug`、`name` 和 `files`。
3. 每个 `files` 条目只含 `relativePath`、`blobSha256`、`mediaType`、`executable`。instruction 建议只放一个 Markdown 文件；Skill 必须有准确大小写的 `SKILL.md`，其他路径相对 Skill 根目录，不带 `skills/<slug>/` 前缀。
4. 创建返回 `{id, revisionId}`。带配置组草稿 `If-Match`，向 `PUT /api/v1/config-sets/:configSetId/configs/:agentId/resources/:resourceId` 发送 `{"sortOrder":0}`（按所需顺序调整非负整数）以选用资源。未选用的资源不会进入该配置发布。
5. GET 配置详情确认 `selectedResources`。Skill 发布后生成到 `skills/<资源slug>/`；不能和原生文件的目标路径碰撞。

更新已有共享资源：`PUT /api/v1/resources/:resourceId`，请求体是 **完整** `{"files":[所有应保留的文件条目]}`，请求头 `If-Match: "资源的revisionId"`，不是配置组数字版本。少传文件等于从新修订移除该文件。响应返回新的 `revisionId`，随后重新读取所有受影响组。

取消选用用上述选用路径 DELETE，带配置组版本。正常选用跟随资源当前修订，发布时冻结；回滚恢复的选用可能固定历史修订，再次 PUT 选用可恢复跟随最新。当前 API 没有通用资源删除、改名或任意历史修订选择接口，不要直接改数据库补功能。

### 创建配置组，或给已有组增加 Agent

- 新组：`POST /api/v1/config-sets`，体为 `{"name":"用户指定名称","slug":"用户指定便携slug","agentId":"omp"}`；slug 只能是小写字母/数字及分隔它们的连字符。返回 `{id, revision}`，初始即含指定 Agent。
- 已有组加 Agent：`POST /api/v1/config-sets/:configSetId/configs`，体为 `{"agentId":"omp"}`，带该组 `If-Match`。已存在会返回 `409 AGENT_CONFIG_ALREADY_EXISTS`。
- 创建成功后 GET 组详情验证 `enabledAgents`，再添加文件、绑定资源和凭据；不能因为创建了空配置就声称已部署完成。
- 删除整个组：仅在明确授权且已评估历史版本与客户端影响时使用 `DELETE /api/v1/config-sets/:configSetId`，带当前 `If-Match`；不能为删除单个 Agent 或文件误删整个组。当前接口没有配置组重命名或移除单个 Agent 的管理操作。

## 7. 发布，让客户端实际收到改动

### 7.1 发布前检查

逐项确认：目标组/Agent 正确；所有期望文件已保存；秘密只以占位符出现在模板中且绑定可解析；共享资源影响已审阅；没有未获授权的其他草稿变化；删除和 executable 变化符合任务。

重新 GET 详情，比较与本次已审阅状态一致后取最终版本，保存原 `currentReleaseId`。如果发生并发修改，停止合并，不要仅更新版本号。单文件 validate 不能代替整组发布校验；不要把“试发布”当作无副作用校验，它成功就会改变客户端的 latest。

### 7.2 创建不可变 Release

仅在用户授权发布且上面的审查已完成后执行；`revision` 必须是最终已审阅版本：

```python
published = api("POST", f"{config_path}/releases",
                {"notes": "记录本次实际修改范围，不包含任何秘密"},
                revision=revision)
release_id = published["releaseId"]
release_number = published["releaseNumber"]
after = api("GET", config_path)
assert after["configSet"]["currentReleaseId"] == release_id
assert after["configSet"]["currentReleaseRevision"] == revision
```

成功为 201，返回 `releaseId`、`releaseNumber`、`manifest`、`diagnostics`。检查诊断中的 warning，不能只看状态码。阻断诊断返回 `422 PUBLISH_VALIDATION_FAILED`，详情在 `error.details`；在受控环境检查，不直接转储敏感文本。示例请求函数为防泄漏仅报告错误码，需检查详情时可在已登录 Web UI 查看。

发布后可用 `GET /api/v1/releases/:releaseId/diff?before=:previousReleaseId` 看两个**已发布**版本的差异；首次发布不传 `before`。敏感文件仅显示元数据，不返回 diff 正文；不要把这种隐藏当作“文件没有改变”。此 diff 不会预览当前草稿。

### 7.3 验证发布输出而不是只验证草稿

在已有授权拉取令牌下：

1. GET `/api/v1/cli/config-sets/:slug/releases/latest?agents=omp`，使用 `Authorization: Bearer <拉取令牌>`。确认 `releaseId` 是刚发布的版本，目标文件、删除结果及 `minCliVersion` 正确。
2. 按 manifest 中的 `fileId` 下载 `/api/v1/cli/releases/:releaseId/files/:fileId`。在内存计算 SHA-256，与 `contentSha256` 比较；含秘密的文件还要确认 `sensitive: true`、占位符已替换、结构可解析，且指定字段等于预期值。只报告比较结果，不打印文件正文。
3. 必要时在隔离 HOME/目标根目录运行实际 CLI pull；先 `--dry-run`，确认写入/删除计划，再执行实际 pull 和 status。具体命令见 [CLI 用法](../README.zh-CN.md#cli)。不直接把生产客户端现有目录当验证沙箱，也不为测试擅自替换符号链接或强制删除修改过的文件。
4. “文件成功下发”不等于“MCP/API 可用”。任务要求服务可用时，另用最小授权请求验证端点，或重新启动/加载目标 Agent 并观察行为；不得用健康检查冒充业务认证成功。

没有可用拉取令牌时，可经管理员授权创建一次性验证令牌：`POST /api/v1/tokens/automation`，体为 `{"label":"本次任务唯一验证名称"}`。返回 `{id, token, prefix}`，token 只保留在内存。**该令牌不是单配置组作用域**，应按可访问全部已发布配置的敏感凭据处理。验证无论成功失败，最终都要 `DELETE /api/v1/tokens/:id` 撤销本次创建的令牌；不要撤销用户已有设备令牌。

## 8. 回滚与故障处理

### 恢复到历史发布

回滚是**整个配置组**的破坏性操作：覆盖当前原生草稿文件和 overlay，恢复历史资源选择、相关冻结凭据绑定与启用 Agent，生成一个新的递增 Release，并立即成为 latest；不是只切换指针，也不是只撤销自己的一次写入。

1. `GET /api/v1/config-sets/:configSetId/releases` 找到用户指定的历史 Release ID；releaseNumber 不是 ID。先保留当前未发布草稿的受限恢复材料，并确认用户授权覆盖其内容。
2. 核对目标版本的密钥是否已在外部撤销。回滚会恢复历史渲染内容，不会自动使用刚轮换的新密钥。
3. 使用最新已审阅草稿版本，`POST /api/v1/config-sets/:configSetId/releases/:releaseId/rollback`，带 `If-Match`，无需业务请求体。
4. 返回 201 和新的 `{releaseId, releaseNumber}`。读回组状态，按第 7.3 节验证新发布；客户端仍需再次 pull。

只想撤销一个尚未发布文件改动时，用第 4 节的旧 Blob 恢复方式，避免整组回滚。删除历史版本使用 `DELETE .../releases/:releaseId`，需要明确授权；当前 Release 不可删除，会返回 `409 CURRENT_RELEASE_CANNOT_BE_DELETED`。清理 Blob 不会替代回滚，日常配置操作也不需要手动 GC。

### 请求失败时如何继续

| 信号 | 下一步 |
| --- | --- |
| `401 UNAUTHORIZED` / `INVALID_CREDENTIALS` | 检查管理员 session 是否过期、是否误用拉取令牌；重新授权登录，不改数据库 |
| `403 ORIGIN_INVALID` | 使用规范公网 Origin，检查代理/请求来源，不禁用来源校验 |
| `409 REVISION_CONFLICT` | 重新读取并比较并发改动，合并获授权变化后重新校验；禁止仅替换 If-Match 重放旧正文 |
| `409 DRAFT_FILE_ALREADY_EXISTS` | 新增目标已存在；审查后决定编辑或换路径，不自动覆盖 |
| `404 AGENT_CONFIG_NOT_FOUND` | 目标组尚无该 Agent，核对后按第 6 节创建 |
| `400 INVALID_REQUEST` | 核对严格请求体字段、Agent ID、布尔值、带双引号的 If-Match 格式 |
| `413` | 单文件校验或正文超限；不能伪装二进制绕过内容限制 |
| `422 PUBLISH_VALIDATION_FAILED` | 查看 `error.details`，修复缺失绑定、非法占位符、格式错误、目标碰撞等，再重新审查发布 |
| `429` | 遵守限流提示，避免登录或设备授权轮询风暴 |
| `500` 或网络超时 | 记录 requestId，先读回草稿/凭据/Release 状态判断是否已成功，再决定操作；不要盲目重复 POST |

部分路径安全或业务错误当前可能映射为 500，不代表应重试。结合受控服务日志定位，不把包含秘密的请求/响应整体转储。Blob 已上传但登记失败时，先恢复登记流程；不要手工删除 Blob 存储文件。

## 9. 收尾与交付

- 新建了验证令牌就撤销；只注销本次建立的管理会话：`POST /api/v1/logout`，成功 204。复用用户浏览器时不要擅自登出用户。
- 删除本次临时敏感文件、隔离验证目录和临时脚本；不删除客户端原有配置或备份。
- 报告配置组 slug、Agent、变更路径、草稿版本变化、是否发布、Release 编号/ID、实际验证范围。只保存草稿就明确说明“客户端尚不会拉到此改动”。
- 工作日志记录“做了什么、为什么、验证了什么、尚未验证什么”，不记录密钥、密码、cookie、token 或含密钥的发布正文。

## 文档验证边界与维护依据

本次编写只对生产执行 Compose 状态与公开健康检查，没有登录管理员、创建文件/凭据/令牌、发布或回滚。Python 示例做语法检查，并对请求函数执行公开健康及未认证只读请求验证；写操作的字段、状态与副作用按以下源码核对，**没有在生产执行写入示例**。首次实际操作仍需按各步骤读回验证，不能把此文档当作生产写入测试报告。

接口仍可能演进。部署 revision 变化后，重新核对这些定义，而不是照搬旧任务中的 ID 或请求：

- [登录、Origin、令牌、CLI 与错误映射](../apps/server/src/routes/api.ts)
- [草稿、资源、凭据、槽、发布管理路由](../apps/server/src/routes/admin-api.ts)
- [Blob 上传和下载](../apps/server/src/routes/blobs.ts)
- [适配器根目录及受管面](../packages/adapters/src/builtin.ts)与[路径限制](../packages/adapters/src/path-safety.ts)
- [秘密完整标量替换](../apps/server/src/security/secret-replacement.ts)
- [凭据轮换](../apps/server/src/services/credential-service.ts)、[槽绑定](../apps/server/src/services/secret-slot-service.ts)、[共享资源修订](../apps/server/src/services/resource-service.ts)
- [发布与回滚](../apps/server/src/services/publish-service.ts)、[已发布版本差异](../apps/server/src/services/release-view-service.ts)

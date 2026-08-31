# Bitbucket MCP

A [Model Context Protocol](https://modelcontextprotocol.io/) server for Bitbucket Cloud and Server. It gives Cursor (and other MCP clients) tools to list repositories, inspect pull requests, read pipelines, and more.

This is a team-maintained fork, run from a local clone and not the public npm package.

[![CodeQL](https://github.com/aaltepet/bitbucket-mcp/actions/workflows/github-code-scanning/codeql/badge.svg)](https://github.com/aaltepet/bitbucket-mcp/actions/workflows/github-code-scanning/codeql)
[![GitHub Repository](https://img.shields.io/badge/GitHub-Repository-blue.svg)](https://github.com/aaltepet/bitbucket-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Safety First

Destructive and mutating tools (merge, decline, approve, create/update PRs, comments, pipelines, deletes, branching-model updates, etc.) are disabled unless `BITBUCKET_ENABLE_DANGEROUS=true`. Read-only tools remain available by default. Logs redact Bitbucket credentials, pagination `next` links are origin-allowlisted, and path/query inputs are encoded/escaped.

## Setup

### 1. Clone and build

Requires Node.js 18 or newer.

```bash
git clone git@github.com:aaltepet/bitbucket-mcp.git
cd bitbucket-mcp
npm install
npm run build
```

`npm run build` compiles TypeScript to `dist/index.js`. After pulling updates, run `npm install` and `npm run build` again.

### 2. Create a Bitbucket access token

The server authenticates with `BITBUCKET_TOKEN` as a Bearer token. Create a [workspace access token](https://support.atlassian.com/bitbucket-cloud/docs/create-a-workspace-access-token/) or a [repository access token](https://support.atlassian.com/bitbucket-cloud/docs/create-a-repository-access-token/).

1. In Bitbucket, open the workspace or repository, then **Settings → Access tokens**.
2. Create a token and grant at least:
   - **Repositories: Read**
   - **Pull requests: Read**
   - **Pipelines: Read** (needed for pipeline tools)
3. Add **Write** scopes only if you will set `BITBUCKET_ENABLE_DANGEROUS=true`.
4. Copy the token immediately. Bitbucket shows it once.

Do not commit the token. Enter it when you add the MCP in Cursor (next step).

To confirm the token works:

```bash
curl -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  "https://api.bitbucket.org/2.0/repositories/YOUR_WORKSPACE"
```

### 3. Add the MCP in Cursor

Open **Cursor Settings → Customize**, then click **+ Add**.

**From Local Repository** (recommended after you clone and build):

1. Choose **From Local Repository**.
2. Select the `bitbucket-mcp` folder you cloned.
3. When prompted, set:
   - `BITBUCKET_TOKEN` — the access token from step 2
   - `BITBUCKET_WORKSPACE` — your workspace slug, e.g. `invenshure`
   - `BITBUCKET_URL` — `https://api.bitbucket.org/2.0` unless you use Bitbucket Server
4. Confirm the server is connected and that Bitbucket tools appear.

**From GitHub Repository**:

1. Choose **From GitHub Repository**.
2. Enter `https://github.com/aaltepet/bitbucket-mcp`.
3. Set the same variables as above.

This repo includes a Cursor plugin manifest (`.cursor-plugin/plugin.json`) and `mcp.json` so Customize can discover the server. The process still runs `node dist/index.js`, so `npm run build` must have succeeded in the checkout Cursor is using. If a GitHub install does not start, clone locally, build, and add **From Local Repository** instead.

You can still edit `~/.cursor/mcp.json` or `.cursor/mcp.json` by hand. Cursor merges both; a project file wins when the same server name appears in both.

## Configuration

| Variable                     | Description                                                                    | Required |
| ---------------------------- | ------------------------------------------------------------------------------ | -------- |
| `BITBUCKET_TOKEN`            | Bitbucket access token (sent as `Authorization: Bearer`)                       | Yes      |
| `BITBUCKET_URL`              | API base URL. Defaults to `https://api.bitbucket.org/2.0`                      | No       |
| `BITBUCKET_WORKSPACE`        | Default workspace. Auto-set if `BITBUCKET_URL` is a `bitbucket.org/<workspace>` web URL | No       |
| `BITBUCKET_ENABLE_DANGEROUS` | Set to `true` to enable mutating tools. Default: read-only tools only          | No       |
| `BITBUCKET_LOG_DISABLE`      | Disable file logging when set to `true`/`1`                                    | No       |
| `BITBUCKET_LOG_FILE`         | Absolute path to a specific log file                                           | No       |
| `BITBUCKET_LOG_DIR`          | Directory to store logs (defaults to OS-specific app log dir)                  | No       |
| `BITBUCKET_LOG_PER_CWD`      | When `true`, nest logs under a per-working-directory subfolder                 | No       |

## Troubleshooting

### Server does not connect in Cursor

1. Confirm `npm run build` succeeded so `dist/index.js` exists in the repo you added.
2. Open **Cursor Settings → Customize**, find the Bitbucket MCP, and confirm `BITBUCKET_TOKEN` is set.
3. Toggle the server off/on, or restart Cursor.
4. Open the Output panel (**View → Output**), select **MCP Logs**, and look for startup or auth errors.

### 401 Authentication Errors

1. Confirm you are using a Bitbucket **access token** in `BITBUCKET_TOKEN`, not your account password.
2. Confirm the token still exists, has not expired, and includes **Repositories: Read**.
3. Use the API base URL `https://api.bitbucket.org/2.0`.
4. Test the token with the `curl` command in [Create a Bitbucket access token](#2-create-a-bitbucket-access-token).

### Getting Help

1. [Bitbucket REST API documentation](https://developer.atlassian.com/cloud/bitbucket/rest/intro/)
2. [Bitbucket Cloud documentation](https://support.atlassian.com/bitbucket-cloud/)
3. [Cursor MCP documentation](https://cursor.com/docs/context/mcp)

## Available Tools

This MCP server provides tools for interacting with Bitbucket repositories and pull requests. Below is a comprehensive list of the available operations:

### Pagination

Unless noted otherwise, listing tools accept the following optional parameters:

- `pagelen`: Number of items per page (Bitbucket `pagelen`). Defaults to 10 and is capped at 100.
- `page`: 1-based Bitbucket page number to fetch. When omitted, the first page is returned.
- `all`: When `true` (and `page` is not provided), the server automatically follows Bitbucket `next` links until all items are fetched or a safety cap of 1,000 entries is reached.
- `limit`: Deprecated alias for `pagelen` kept for backward compatibility.

Use these knobs to page through large collections without hitting CLI truncation.

### Repository Operations

#### `listRepositories`

Lists repositories in a workspace.

**Parameters:**

- `workspace` (optional): Bitbucket workspace name
- `name` (optional): Filter repositories by partial name match
- Pagination controls described in [Pagination](#pagination)

#### `getRepository`

Gets details for a specific repository.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug

### Pull Request Operations

#### `getPullRequests`

Gets pull requests for a repository.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `state` (optional): Pull request state (`OPEN`, `MERGED`, `DECLINED`, `SUPERSEDED`)
- Pagination controls described in [Pagination](#pagination)

#### `createPullRequest`

Creates a new pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `title`: Pull request title
- `description`: Pull request description
- `sourceBranch`: Source branch name
- `targetBranch`: Target branch name
- `reviewers` (optional): List of reviewer usernames
- `draft` (optional): Whether to create the pull request as a draft

#### `getPullRequest`

Gets details for a specific pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- Pagination controls described in [Pagination](#pagination)
- Pagination controls described in [Pagination](#pagination)
- Pagination controls described in [Pagination](#pagination)
- Pagination controls described in [Pagination](#pagination)

#### `updatePullRequest`

Updates a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- Pagination controls described in [Pagination](#pagination)
- Pagination controls described in [Pagination](#pagination)
- Various optional update parameters (title, description, etc.)

#### `getPullRequestActivity`

Gets the activity log for a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `approvePullRequest`

Approves a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `unapprovePullRequest`

Removes an approval from a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `declinePullRequest`

Declines a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `message` (optional): Reason for declining

#### `mergePullRequest`

Merges a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `message` (optional): Merge commit message
- `strategy` (optional): Merge strategy (`merge-commit`, `squash`, `fast-forward`)

#### `requestChanges`

Requests changes on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `removeChangeRequest`

Removes a change request from a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `createDraftPullRequest`

Creates a new draft pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `title`: Pull request title
- `description`: Pull request description
- `sourceBranch`: Source branch name
- `targetBranch`: Target branch name
- `reviewers` (optional): List of reviewer usernames

**Note:** This is equivalent to calling `createPullRequest` with `draft: true`.

#### `publishDraftPullRequest`

Publishes a draft pull request to make it ready for review.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `convertTodraft`

Converts a regular pull request to draft status.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

### Pull Request Comment Operations

#### `getPullRequestComments`

Lists comments on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `addPullRequestComment`

Creates a comment on a pull request (general or inline).

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `content`: Comment content in markdown format
- `inline` (optional): Inline comment information for commenting on specific lines

**Inline Comment Format:**

The `inline` parameter allows you to create comments on specific lines of code in the pull request diff:

```json
{
  "path": "src/file.ts",
  "to": 15, // Line number in NEW version (for added/modified lines)
  "from": 10 // Line number in OLD version (for deleted/modified lines)
}
```

**Examples:**

- **General comment**: Omit the `inline` parameter for a general pull request comment
- **Comment on new line**: Use only `to` parameter
- **Comment on deleted line**: Use only `from` parameter
- **Comment on modified line**: Use both `from` and `to` parameters

**Usage:**

```javascript
// General comment
addPullRequestComment(workspace, repo, pr_id, "Great work!");

// Inline comment on new line 25
addPullRequestComment(workspace, repo, pr_id, "Consider error handling here", {
  path: "src/service.ts",
  to: 25,
});
```

#### `getPullRequestComment`

Gets a specific comment on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `comment_id`: Comment ID

#### `updatePullRequestComment`

Updates a comment on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `comment_id`: Comment ID
- `content`: Updated comment content

#### `deletePullRequestComment`

Deletes a comment on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `comment_id`: Comment ID

#### `resolveComment`

Resolves a comment thread on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `comment_id`: Comment ID

#### `reopenComment`

Reopens a resolved comment thread on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `comment_id`: Comment ID

### Pull Request Diff Operations

#### `getPullRequestDiff`

Gets the diff for a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `getPullRequestDiffStat`

Gets the diff statistics for a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `getPullRequestPatch`

Gets the patch for a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

### Pull Request Task Operations

#### `getPullRequestTasks`

Lists tasks on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `createPullRequestTask`

Creates a task on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `content`: Task content
- `comment` (optional): Comment ID to associate with the task
- `pending` (optional): Whether the task is pending

#### `getPullRequestTask`

Gets a specific task on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `task_id`: Task ID

#### `updatePullRequestTask`

Updates a task on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `task_id`: Task ID
- `content` (optional): Updated task content
- `state` (optional): Updated task state

#### `deletePullRequestTask`

Deletes a task on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID
- `task_id`: Task ID

### Other Pull Request Operations

#### `getPullRequestCommits`

Lists commits on a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

#### `getPullRequestStatuses`

Lists commit statuses for a pull request.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pull_request_id`: Pull request ID

### Pipeline Operations

#### `listPipelineRuns`

Lists pipeline runs for a repository.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- Pagination controls described in [Pagination](#pagination)
- `status` (optional): Filter pipelines by status (`PENDING`, `IN_PROGRESS`, `SUCCESSFUL`, `FAILED`, `ERROR`, `STOPPED`)
- `target_branch` (optional): Filter pipelines by target branch
- `trigger_type` (optional): Filter pipelines by trigger type (`manual`, `push`, `pullrequest`, `schedule`)

#### `getPipelineRun`

Gets details for a specific pipeline run.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pipeline_uuid`: Pipeline UUID
- Pagination controls described in [Pagination](#pagination)

#### `runPipeline`

Triggers a new pipeline run.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `target`: Pipeline target configuration (object with `ref_type`, `ref_name`, and optional `commit_hash`, `selector_type`, `selector_pattern`)
- `variables` (optional): Array of pipeline variables (objects with `key`, `value`, and optional `secured` fields)

#### `stopPipeline`

Stops a running pipeline.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pipeline_uuid`: Pipeline UUID

#### `getPipelineSteps`

Lists steps for a pipeline run.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pipeline_uuid`: Pipeline UUID

#### `getPipelineStep`

Gets details for a specific pipeline step.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pipeline_uuid`: Pipeline UUID
- `step_uuid`: Step UUID

#### `getPipelineStepLogs`

Gets logs for a specific pipeline step.

**Parameters:**

- `workspace`: Bitbucket workspace name
- `repo_slug`: Repository slug
- `pipeline_uuid`: Pipeline UUID
- `step_uuid`: Step UUID

## Development

After the [clone and build](#1-clone-and-build) steps:

```bash
npm run dev      # watch mode (tsx)
npm test         # Jest
npm run lint     # ESLint
npm run inspector  # MCP inspector against dist/index.js
```

Rebuild (`npm run build`) and toggle the Cursor MCP server after you change TypeScript sources. Cursor runs `dist/index.js`, not `src/`.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Links

- [This fork](https://github.com/aaltepet/bitbucket-mcp)
- [Upstream](https://github.com/MatanYemini/bitbucket-mcp)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Cursor MCP documentation](https://cursor.com/docs/context/mcp)
- [Bitbucket REST API Documentation](https://developer.atlassian.com/cloud/bitbucket/rest/intro/)
- [Bitbucket Cloud Documentation](https://support.atlassian.com/bitbucket-cloud/)

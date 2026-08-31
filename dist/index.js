#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import winston from "winston";
import os from "os";
import path from "path";
import fs from "fs";
import { BitbucketPaginator, BITBUCKET_ALL_ITEMS_CAP, BITBUCKET_DEFAULT_PAGELEN, BITBUCKET_MAX_PAGELEN, } from "./pagination.js";
import { buildRepositoryNameFilter, encodePathSegment, redactSecretsFormat, sanitizeForLog, } from "./security.js";
// =========== LOGGER SETUP ==========
// File-based logging with sensible defaults and ability to disable
function getDefaultLogDirectory() {
    if (process.platform === "win32") {
        const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        return path.join(base, "bitbucket-mcp");
    }
    if (process.platform === "darwin") {
        return path.join(os.homedir(), "Library", "Logs", "bitbucket-mcp");
    }
    const xdgStateHome = process.env.XDG_STATE_HOME;
    if (xdgStateHome && xdgStateHome.length > 0) {
        return path.join(xdgStateHome, "bitbucket-mcp");
    }
    return path.join(os.homedir(), ".local", "state", "bitbucket-mcp");
}
function isTruthyEnv(value) {
    if (value === undefined || value === null)
        return false;
    const normalized = String(value).toLowerCase();
    return ["1", "true", "yes", "on"].includes(normalized);
}
function getLogFilePath() {
    if (isTruthyEnv(process.env.BITBUCKET_LOG_DISABLE)) {
        return undefined;
    }
    const explicitFile = process.env.BITBUCKET_LOG_FILE;
    if (explicitFile && explicitFile.trim().length > 0) {
        return explicitFile;
    }
    const baseDir = process.env.BITBUCKET_LOG_DIR &&
        process.env.BITBUCKET_LOG_DIR.trim().length > 0
        ? process.env.BITBUCKET_LOG_DIR
        : getDefaultLogDirectory();
    let effectiveDir = baseDir;
    if (isTruthyEnv(process.env.BITBUCKET_LOG_PER_CWD)) {
        const sanitizedCwd = process
            .cwd()
            .replace(/[\\/]/g, "_")
            .replace(/[:*?"<>|]/g, "");
        effectiveDir = path.join(baseDir, sanitizedCwd);
    }
    try {
        fs.mkdirSync(effectiveDir, { recursive: true });
    }
    catch {
        return undefined; // If we cannot create the directory, disable file logging rather than polluting CWD
    }
    return path.join(effectiveDir, "bitbucket.log");
}
const resolvedLogFile = getLogFilePath();
const logger = winston.createLogger({
    level: "info",
    format: winston.format.combine(redactSecretsFormat(), winston.format.json()),
    transports: resolvedLogFile
        ? [new winston.transports.File({ filename: resolvedLogFile })]
        : [],
});
const PAGINATION_BASE_SCHEMA = {
    pagelen: {
        type: "number",
        minimum: 1,
        maximum: BITBUCKET_MAX_PAGELEN,
        description: `Number of items per page (Bitbucket pagelen). Defaults to ${BITBUCKET_DEFAULT_PAGELEN} and caps at ${BITBUCKET_MAX_PAGELEN}.`,
    },
    page: {
        type: "number",
        minimum: 1,
        description: "Bitbucket page number to fetch (1-based).",
    },
};
const PAGINATION_ALL_SCHEMA = {
    type: "boolean",
    description: `When true (and no page is provided), automatically follows Bitbucket next links to return all items up to ${BITBUCKET_ALL_ITEMS_CAP}.`,
};
const LEGACY_LIMIT_SCHEMA = {
    type: "number",
    description: "Deprecated alias for pagelen. Use pagelen/page/all for pagination control.",
};
// Normalize Bitbucket configuration for backward compatibility and DX
function normalizeBitbucketConfig(rawConfig) {
    let normalizedConfig = { ...rawConfig };
    try {
        const parsed = new URL(rawConfig.baseUrl);
        const host = parsed.hostname.toLowerCase();
        // If users provide a web URL like https://bitbucket.org/<workspace>,
        // extract the workspace and switch to the public API base URL
        if (host === "bitbucket.org" || host === "www.bitbucket.org") {
            const segments = parsed.pathname.split("/").filter(Boolean);
            if (!normalizedConfig.defaultWorkspace && segments.length >= 1) {
                normalizedConfig.defaultWorkspace = segments[0];
            }
            normalizedConfig.baseUrl = "https://api.bitbucket.org/2.0";
        }
        // If users provide https://api.bitbucket.org (without /2.0), ensure /2.0
        if (host === "api.bitbucket.org") {
            const pathname = parsed.pathname.replace(/\/+$/, "");
            if (!pathname.startsWith("/2.0")) {
                normalizedConfig.baseUrl = "https://api.bitbucket.org/2.0";
            }
            else {
                normalizedConfig.baseUrl = "https://api.bitbucket.org/2.0";
            }
        }
        // Remove trailing slashes for a consistent axios baseURL
        normalizedConfig.baseUrl = normalizedConfig.baseUrl.replace(/\/+$/, "");
    }
    catch {
        // If baseUrl is not a valid absolute URL, keep as-is (custom/self-hosted cases)
    }
    return normalizedConfig;
}
// =========== MCP SERVER ===========
class BitbucketServer {
    isDangerousTool(name) {
        return !this.safeToolNames.has(name);
    }
    constructor() {
        /**
         * Read-only tools that remain available without BITBUCKET_ENABLE_DANGEROUS.
         * Everything else (writes, merges, pipelines, deletes, etc.) is gated.
         */
        this.safeToolNames = new Set([
            "listRepositories",
            "getRepository",
            "getPullRequests",
            "getPullRequest",
            "getPullRequestActivity",
            "getPullRequestComments",
            "getPullRequestComment",
            "getPullRequestDiff",
            "getPullRequestDiffStat",
            "getPullRequestPatch",
            "getPullRequestCommits",
            "getPullRequestTasks",
            "getPullRequestTask",
            "getPullRequestStatuses",
            "getRepositoryBranchingModel",
            "getRepositoryBranchingModelSettings",
            "getEffectiveRepositoryBranchingModel",
            "getProjectBranchingModel",
            "getProjectBranchingModelSettings",
            "getPendingReviewPRs",
            "listPipelineRuns",
            "getPipelineRun",
            "getPipelineSteps",
            "getPipelineStep",
            "getPipelineStepLogs",
            "getEffectiveDefaultReviewers",
        ]);
        // Initialize with the older Server class pattern
        this.server = new Server({
            name: "bitbucket-mcp-server",
            version: "1.0.0",
        }, {
            capabilities: {
                tools: {},
            },
        });
        // Configuration from environment variables
        const initialConfig = {
            baseUrl: process.env.BITBUCKET_URL ?? "https://api.bitbucket.org/2.0",
            token: process.env.BITBUCKET_TOKEN ?? "",
            defaultWorkspace: process.env.BITBUCKET_WORKSPACE,
        };
        const normalizedConfig = normalizeBitbucketConfig(initialConfig);
        if (normalizedConfig.baseUrl !== initialConfig.baseUrl ||
            normalizedConfig.defaultWorkspace !== initialConfig.defaultWorkspace) {
            logger.info("Normalized Bitbucket configuration", {
                fromBaseUrl: initialConfig.baseUrl,
                toBaseUrl: normalizedConfig.baseUrl,
                defaultWorkspace: normalizedConfig.defaultWorkspace,
            });
        }
        // Parse dangerous commands toggle (off by default)
        const enableDangerousEnv = (process.env.BITBUCKET_ENABLE_DANGEROUS ??
            process.env.BITBUCKET_ALLOW_DANGEROUS ??
            "")
            .toString()
            .toLowerCase();
        const allowDangerousCommands = ["1", "true", "yes", "on"].includes(enableDangerousEnv);
        this.config = { ...normalizedConfig, allowDangerousCommands };
        // Validate required config
        if (!this.config.baseUrl) {
            throw new Error("BITBUCKET_URL is required");
        }
        if (!this.config.token) {
            throw new Error("BITBUCKET_TOKEN is required");
        }
        this.api = axios.create({
            baseURL: this.config.baseUrl,
            headers: {
                Authorization: `Bearer ${this.config.token}`,
            },
        });
        this.paginator = new BitbucketPaginator(this.api, logger, {
            baseUrl: this.config.baseUrl,
        });
        // Setup tool handlers using the request handler pattern
        this.setupToolHandlers();
        // Add error handler - CRITICAL for stability
        this.server.onerror = (error) => logger.error("[MCP Error]", { error: sanitizeForLog(error) });
    }
    setupToolHandlers() {
        // Register the list tools handler
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: "listRepositories",
                    description: "List Bitbucket repositories",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            name: {
                                type: "string",
                                description: "Filter repositories by name (partial match supported)",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                            limit: LEGACY_LIMIT_SCHEMA,
                        },
                    },
                },
                {
                    name: "getRepository",
                    description: "Get repository details",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                        },
                        required: ["workspace", "repo_slug"],
                    },
                },
                {
                    name: "getPullRequests",
                    description: "Get pull requests for a repository",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            state: {
                                type: "string",
                                enum: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
                                description: "Pull request state",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                            limit: LEGACY_LIMIT_SCHEMA,
                        },
                        required: ["workspace", "repo_slug"],
                    },
                },
                {
                    name: "createPullRequest",
                    description: "Create a new pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            title: { type: "string", description: "Pull request title" },
                            description: {
                                type: "string",
                                description: "Pull request description",
                            },
                            sourceBranch: {
                                type: "string",
                                description: "Source branch name",
                            },
                            targetBranch: {
                                type: "string",
                                description: "Target branch name",
                            },
                            reviewers: {
                                type: "array",
                                items: { type: "string" },
                                description: "List of reviewer UUIDs (e.g., '{04776764-62c7-453b-b97e-302f60395ceb}')",
                            },
                            draft: {
                                type: "boolean",
                                description: "Whether to create the pull request as a draft",
                            },
                        },
                        required: [
                            "workspace",
                            "repo_slug",
                            "title",
                            "description",
                            "sourceBranch",
                            "targetBranch",
                        ],
                    },
                },
                {
                    name: "getPullRequest",
                    description: "Get details for a specific pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "updatePullRequest",
                    description: "Update a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            title: { type: "string", description: "New pull request title" },
                            description: {
                                type: "string",
                                description: "New pull request description",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getPullRequestActivity",
                    description: "Get activity log for a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "approvePullRequest",
                    description: "Approve a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "unapprovePullRequest",
                    description: "Remove approval from a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "declinePullRequest",
                    description: "Decline a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            message: { type: "string", description: "Reason for declining" },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "mergePullRequest",
                    description: "Merge a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            message: { type: "string", description: "Merge commit message" },
                            strategy: {
                                type: "string",
                                enum: ["merge-commit", "squash", "fast-forward"],
                                description: "Merge strategy",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getPullRequestComments",
                    description: "List comments on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getPullRequestDiff",
                    description: "Get diff for a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getPullRequestCommits",
                    description: "Get commits on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "addPullRequestComment",
                    description: "Add a comment to a pull request (general, inline, or a threaded reply to another comment)",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            content: {
                                type: "string",
                                description: "Comment content in markdown format",
                            },
                            pending: {
                                type: "boolean",
                                description: "Whether to create this comment as a pending comment (draft state)",
                            },
                            parent_id: {
                                type: "number",
                                description: "If set, posts this comment as a threaded reply to the given comment id. The reply inherits the parent's inline anchor (if any); do not also pass `inline` when replying.",
                            },
                            inline: {
                                type: "object",
                                description: "Inline comment information for commenting on specific lines. Ignored when `parent_id` is set.",
                                properties: {
                                    path: {
                                        type: "string",
                                        description: "Path to the file in the repository",
                                    },
                                    from: {
                                        type: "number",
                                        description: "Line number in the old version of the file (for deleted or modified lines)",
                                    },
                                    to: {
                                        type: "number",
                                        description: "Line number in the new version of the file (for added or modified lines)",
                                    },
                                },
                                required: ["path"],
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id", "content"],
                    },
                },
                {
                    name: "addPendingPullRequestComment",
                    description: "Add a pending (draft) comment to a pull request that can be published later",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            content: {
                                type: "string",
                                description: "Comment content in markdown format",
                            },
                            inline: {
                                type: "object",
                                description: "Inline comment information for commenting on specific lines",
                                properties: {
                                    path: {
                                        type: "string",
                                        description: "Path to the file in the repository",
                                    },
                                    from: {
                                        type: "number",
                                        description: "Line number in the old version of the file (for deleted or modified lines)",
                                    },
                                    to: {
                                        type: "number",
                                        description: "Line number in the new version of the file (for added or modified lines)",
                                    },
                                },
                                required: ["path"],
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id", "content"],
                    },
                },
                {
                    name: "publishPendingComments",
                    description: "Publish all pending comments for a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getRepositoryBranchingModel",
                    description: "Get the branching model for a repository",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                        },
                        required: ["workspace", "repo_slug"],
                    },
                },
                {
                    name: "getRepositoryBranchingModelSettings",
                    description: "Get the branching model config for a repository",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                        },
                        required: ["workspace", "repo_slug"],
                    },
                },
                {
                    name: "updateRepositoryBranchingModelSettings",
                    description: "Update the branching model config for a repository",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            development: {
                                type: "object",
                                description: "Development branch settings",
                                properties: {
                                    name: { type: "string", description: "Branch name" },
                                    use_mainbranch: {
                                        type: "boolean",
                                        description: "Use main branch",
                                    },
                                },
                            },
                            production: {
                                type: "object",
                                description: "Production branch settings",
                                properties: {
                                    name: { type: "string", description: "Branch name" },
                                    use_mainbranch: {
                                        type: "boolean",
                                        description: "Use main branch",
                                    },
                                    enabled: {
                                        type: "boolean",
                                        description: "Enable production branch",
                                    },
                                },
                            },
                            branch_types: {
                                type: "array",
                                description: "Branch types configuration",
                                items: {
                                    type: "object",
                                    properties: {
                                        kind: {
                                            type: "string",
                                            description: "Branch type kind (e.g., bugfix, feature)",
                                        },
                                        prefix: { type: "string", description: "Branch prefix" },
                                        enabled: {
                                            type: "boolean",
                                            description: "Enable this branch type",
                                        },
                                    },
                                    required: ["kind"],
                                },
                            },
                        },
                        required: ["workspace", "repo_slug"],
                    },
                },
                {
                    name: "getEffectiveRepositoryBranchingModel",
                    description: "Get the effective branching model for a repository",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                        },
                        required: ["workspace", "repo_slug"],
                    },
                },
                {
                    name: "getProjectBranchingModel",
                    description: "Get the branching model for a project",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            project_key: { type: "string", description: "Project key" },
                        },
                        required: ["workspace", "project_key"],
                    },
                },
                {
                    name: "getProjectBranchingModelSettings",
                    description: "Get the branching model config for a project",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            project_key: { type: "string", description: "Project key" },
                        },
                        required: ["workspace", "project_key"],
                    },
                },
                {
                    name: "updateProjectBranchingModelSettings",
                    description: "Update the branching model config for a project",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            project_key: { type: "string", description: "Project key" },
                            development: {
                                type: "object",
                                description: "Development branch settings",
                                properties: {
                                    name: { type: "string", description: "Branch name" },
                                    use_mainbranch: {
                                        type: "boolean",
                                        description: "Use main branch",
                                    },
                                },
                            },
                            production: {
                                type: "object",
                                description: "Production branch settings",
                                properties: {
                                    name: { type: "string", description: "Branch name" },
                                    use_mainbranch: {
                                        type: "boolean",
                                        description: "Use main branch",
                                    },
                                    enabled: {
                                        type: "boolean",
                                        description: "Enable production branch",
                                    },
                                },
                            },
                            branch_types: {
                                type: "array",
                                description: "Branch types configuration",
                                items: {
                                    type: "object",
                                    properties: {
                                        kind: {
                                            type: "string",
                                            description: "Branch type kind (e.g., bugfix, feature)",
                                        },
                                        prefix: { type: "string", description: "Branch prefix" },
                                        enabled: {
                                            type: "boolean",
                                            description: "Enable this branch type",
                                        },
                                    },
                                    required: ["kind"],
                                },
                            },
                        },
                        required: ["workspace", "project_key"],
                    },
                },
                {
                    name: "createDraftPullRequest",
                    description: "Create a new draft pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            title: { type: "string", description: "Pull request title" },
                            description: {
                                type: "string",
                                description: "Pull request description",
                            },
                            sourceBranch: {
                                type: "string",
                                description: "Source branch name",
                            },
                            targetBranch: {
                                type: "string",
                                description: "Target branch name",
                            },
                            reviewers: {
                                type: "array",
                                items: { type: "string" },
                                description: "List of reviewer UUIDs (e.g., '{04776764-62c7-453b-b97e-302f60395ceb}')",
                            },
                        },
                        required: [
                            "workspace",
                            "repo_slug",
                            "title",
                            "description",
                            "sourceBranch",
                            "targetBranch",
                        ],
                    },
                },
                {
                    name: "publishDraftPullRequest",
                    description: "Publish a draft pull request to make it ready for review",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "convertTodraft",
                    description: "Convert a regular pull request to draft status",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getPendingReviewPRs",
                    description: "List all open pull requests in the workspace where the reviewer is assigned and has not yet approved. Resolves the reviewer from GET /user unless reviewer is provided.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name (optional, defaults to BITBUCKET_WORKSPACE)",
                            },
                            limit: {
                                type: "number",
                                description: "Maximum number of PRs to return (optional)",
                            },
                            repositoryList: {
                                type: "array",
                                items: { type: "string" },
                                description: "List of repository slugs to check (optional)",
                            },
                            reviewer: {
                                type: "string",
                                description: "Reviewer nickname to match. Optional when the access token can call GET /user.",
                            },
                        },
                    },
                },
                {
                    name: "listPipelineRuns",
                    description: "List pipeline runs for a repository",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                            limit: LEGACY_LIMIT_SCHEMA,
                            status: {
                                type: "string",
                                enum: [
                                    "PENDING",
                                    "IN_PROGRESS",
                                    "SUCCESSFUL",
                                    "FAILED",
                                    "ERROR",
                                    "STOPPED",
                                ],
                                description: "Filter pipelines by status",
                            },
                            target_branch: {
                                type: "string",
                                description: "Filter pipelines by target branch",
                            },
                            trigger_type: {
                                type: "string",
                                enum: ["manual", "push", "pullrequest", "schedule"],
                                description: "Filter pipelines by trigger type",
                            },
                            sort: {
                                type: "string",
                                description: "Field to sort by. Prefix with '-' for descending order. Supported fields: created_on, creator.uuid. Example: '-created_on' for newest first.",
                            },
                        },
                        required: ["workspace", "repo_slug"],
                    },
                },
                {
                    name: "getPipelineRun",
                    description: "Get details for a specific pipeline run",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pipeline_uuid: {
                                type: "string",
                                description: "Pipeline UUID",
                            },
                            ...PAGINATION_BASE_SCHEMA,
                            all: PAGINATION_ALL_SCHEMA,
                        },
                        required: ["workspace", "repo_slug", "pipeline_uuid"],
                    },
                },
                {
                    name: "runPipeline",
                    description: "Trigger a new pipeline run",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            target: {
                                type: "object",
                                description: "Pipeline target configuration",
                                properties: {
                                    ref_type: {
                                        type: "string",
                                        enum: ["branch", "tag", "bookmark", "named_branch"],
                                        description: "Reference type",
                                    },
                                    ref_name: {
                                        type: "string",
                                        description: "Reference name (branch, tag, etc.)",
                                    },
                                    commit_hash: {
                                        type: "string",
                                        description: "Specific commit hash to run pipeline on",
                                    },
                                    selector_type: {
                                        type: "string",
                                        enum: ["default", "custom", "pull-requests"],
                                        description: "Pipeline selector type",
                                    },
                                    selector_pattern: {
                                        type: "string",
                                        description: "Pipeline selector pattern (for custom pipelines)",
                                    },
                                },
                                required: ["ref_type", "ref_name"],
                            },
                            variables: {
                                type: "array",
                                description: "Pipeline variables",
                                items: {
                                    type: "object",
                                    properties: {
                                        key: { type: "string", description: "Variable name" },
                                        value: { type: "string", description: "Variable value" },
                                        secured: {
                                            type: "boolean",
                                            description: "Whether the variable is secured",
                                        },
                                    },
                                    required: ["key", "value"],
                                },
                            },
                        },
                        required: ["workspace", "repo_slug", "target"],
                    },
                },
                {
                    name: "stopPipeline",
                    description: "Stop a running pipeline",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pipeline_uuid: {
                                type: "string",
                                description: "Pipeline UUID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pipeline_uuid"],
                    },
                },
                {
                    name: "getPipelineSteps",
                    description: "List steps for a pipeline run",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pipeline_uuid: {
                                type: "string",
                                description: "Pipeline UUID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pipeline_uuid"],
                    },
                },
                {
                    name: "getPipelineStep",
                    description: "Get details for a specific pipeline step",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pipeline_uuid: {
                                type: "string",
                                description: "Pipeline UUID",
                            },
                            step_uuid: {
                                type: "string",
                                description: "Step UUID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pipeline_uuid", "step_uuid"],
                    },
                },
                {
                    name: "getPipelineStepLogs",
                    description: "Get logs for a specific pipeline step",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pipeline_uuid: {
                                type: "string",
                                description: "Pipeline UUID",
                            },
                            step_uuid: {
                                type: "string",
                                description: "Step UUID",
                            },
                            max_lines: {
                                type: "number",
                                description: "Maximum number of log lines to return (default 500)",
                                minimum: 1,
                                maximum: 5000,
                            },
                            tail: {
                                type: "boolean",
                                description: "When true, returns the most recent lines instead of the first lines",
                            },
                            errors_only: {
                                type: "boolean",
                                description: "When true, only include lines that look like errors (case-insensitive match on error keywords)",
                            },
                            search_term: {
                                type: "string",
                                description: "Optional case-insensitive search term to filter log lines",
                            },
                            save_to_file: {
                                type: "boolean",
                                description: "Save the full log to a temporary file and return the path for offline review",
                            },
                        },
                        required: ["workspace", "repo_slug", "pipeline_uuid", "step_uuid"],
                    },
                },
                {
                    name: "getPullRequestComment",
                    description: "Get a specific comment on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            comment_id: { type: "string", description: "Comment ID" },
                        },
                        required: [
                            "workspace",
                            "repo_slug",
                            "pull_request_id",
                            "comment_id",
                        ],
                    },
                },
                {
                    name: "updatePullRequestComment",
                    description: "Update a comment on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            comment_id: { type: "string", description: "Comment ID" },
                            content: {
                                type: "string",
                                description: "Updated comment content",
                            },
                        },
                        required: [
                            "workspace",
                            "repo_slug",
                            "pull_request_id",
                            "comment_id",
                            "content",
                        ],
                    },
                },
                {
                    name: "deletePullRequestComment",
                    description: "Delete a comment on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            comment_id: { type: "string", description: "Comment ID" },
                        },
                        required: [
                            "workspace",
                            "repo_slug",
                            "pull_request_id",
                            "comment_id",
                        ],
                    },
                },
                {
                    name: "resolveComment",
                    description: "Resolve a comment thread on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            comment_id: { type: "string", description: "Comment ID" },
                        },
                        required: [
                            "workspace",
                            "repo_slug",
                            "pull_request_id",
                            "comment_id",
                        ],
                    },
                },
                {
                    name: "reopenComment",
                    description: "Reopen a resolved comment thread on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            comment_id: { type: "string", description: "Comment ID" },
                        },
                        required: [
                            "workspace",
                            "repo_slug",
                            "pull_request_id",
                            "comment_id",
                        ],
                    },
                },
                {
                    name: "getPullRequestDiffStat",
                    description: "Get diff statistics for a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getPullRequestPatch",
                    description: "Get patch for a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getPullRequestTasks",
                    description: "List tasks on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "createPullRequestTask",
                    description: "Create a task on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            content: { type: "string", description: "Task content" },
                            comment: {
                                type: "number",
                                description: "Optional comment ID to attach the task",
                            },
                            state: {
                                type: "string",
                                enum: ["OPEN", "RESOLVED"],
                                description: "Initial task state",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id", "content"],
                    },
                },
                {
                    name: "getPullRequestTask",
                    description: "Get a specific task on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            task_id: { type: "string", description: "Task ID" },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id", "task_id"],
                    },
                },
                {
                    name: "updatePullRequestTask",
                    description: "Update a task on a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            task_id: { type: "string", description: "Task ID" },
                            content: { type: "string", description: "Updated task content" },
                            state: {
                                type: "string",
                                enum: ["OPEN", "RESOLVED"],
                                description: "Updated task state",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id", "task_id"],
                    },
                },
                {
                    name: "deletePullRequestTask",
                    description: "Delete a task from a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                            task_id: { type: "string", description: "Task ID" },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id", "task_id"],
                    },
                },
                {
                    name: "getPullRequestStatuses",
                    description: "List commit statuses associated with a pull request",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                            pull_request_id: {
                                type: "string",
                                description: "Pull request ID",
                            },
                        },
                        required: ["workspace", "repo_slug", "pull_request_id"],
                    },
                },
                {
                    name: "getEffectiveDefaultReviewers",
                    description: "Get effective default reviewers for a repository",
                    inputSchema: {
                        type: "object",
                        properties: {
                            workspace: {
                                type: "string",
                                description: "Bitbucket workspace name",
                            },
                            repo_slug: { type: "string", description: "Repository slug" },
                        },
                        required: ["workspace", "repo_slug"],
                    },
                },
            ].filter((tool) => this.config.allowDangerousCommands === true ||
                !this.isDangerousTool(tool.name)),
        }));
        // Register the call tool handler
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                const args = request.params.arguments ?? {};
                const toolName = request.params.name;
                logger.info(`Called tool: ${toolName}`, {
                    argumentKeys: Object.keys(args),
                });
                // Guard dangerous tools when not enabled
                if (this.isDangerousTool(toolName) &&
                    this.config.allowDangerousCommands !== true) {
                    throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} is disabled. Set BITBUCKET_ENABLE_DANGEROUS=true to enable write/merge/pipeline tools.`);
                }
                switch (request.params.name) {
                    case "listRepositories":
                        return await this.listRepositories(args.workspace, args.pagelen, args.page, args.all, args.name, args.limit);
                    case "getRepository":
                        return await this.getRepository(args.workspace, args.repo_slug);
                    case "getPullRequests":
                        return await this.getPullRequests(args.workspace, args.repo_slug, args.state, args.pagelen, args.page, args.all, args.limit);
                    case "createPullRequest":
                        return await this.createPullRequest(args.workspace, args.repo_slug, args.title, args.description, args.sourceBranch, args.targetBranch, args.reviewers, args.draft);
                    case "getPullRequest":
                        return await this.getPullRequest(args.workspace, args.repo_slug, args.pull_request_id);
                    case "updatePullRequest":
                        return await this.updatePullRequest(args.workspace, args.repo_slug, args.pull_request_id, args.title, args.description);
                    case "getPullRequestActivity":
                        return await this.getPullRequestActivity(args.workspace, args.repo_slug, args.pull_request_id, args.pagelen, args.page, args.all);
                    case "approvePullRequest":
                        return await this.approvePullRequest(args.workspace, args.repo_slug, args.pull_request_id);
                    case "unapprovePullRequest":
                        return await this.unapprovePullRequest(args.workspace, args.repo_slug, args.pull_request_id);
                    case "declinePullRequest":
                        return await this.declinePullRequest(args.workspace, args.repo_slug, args.pull_request_id, args.message);
                    case "mergePullRequest":
                        return await this.mergePullRequest(args.workspace, args.repo_slug, args.pull_request_id, args.message, args.strategy);
                    case "getPullRequestComments":
                        return await this.getPullRequestComments(args.workspace, args.repo_slug, args.pull_request_id, args.pagelen, args.page, args.all);
                    case "getPullRequestDiff":
                        return await this.getPullRequestDiff(args.workspace, args.repo_slug, args.pull_request_id);
                    case "getPullRequestCommits":
                        return await this.getPullRequestCommits(args.workspace, args.repo_slug, args.pull_request_id, args.pagelen, args.page, args.all);
                    case "addPullRequestComment":
                        return await this.addPullRequestComment(args.workspace, args.repo_slug, args.pull_request_id, args.content, args.inline, args.pending, args.parent_id);
                    case "addPendingPullRequestComment":
                        return await this.addPendingPullRequestComment(args.workspace, args.repo_slug, args.pull_request_id, args.content, args.inline);
                    case "publishPendingComments":
                        return await this.publishPendingComments(args.workspace, args.repo_slug, args.pull_request_id);
                    case "getRepositoryBranchingModel":
                        return await this.getRepositoryBranchingModel(args.workspace, args.repo_slug);
                    case "getRepositoryBranchingModelSettings":
                        return await this.getRepositoryBranchingModelSettings(args.workspace, args.repo_slug);
                    case "updateRepositoryBranchingModelSettings":
                        return await this.updateRepositoryBranchingModelSettings(args.workspace, args.repo_slug, args.development, args.production, args.branch_types);
                    case "getEffectiveRepositoryBranchingModel":
                        return await this.getEffectiveRepositoryBranchingModel(args.workspace, args.repo_slug);
                    case "getProjectBranchingModel":
                        return await this.getProjectBranchingModel(args.workspace, args.project_key);
                    case "getProjectBranchingModelSettings":
                        return await this.getProjectBranchingModelSettings(args.workspace, args.project_key);
                    case "updateProjectBranchingModelSettings":
                        return await this.updateProjectBranchingModelSettings(args.workspace, args.project_key, args.development, args.production, args.branch_types);
                    case "createDraftPullRequest":
                        return await this.createDraftPullRequest(args.workspace, args.repo_slug, args.title, args.description, args.sourceBranch, args.targetBranch, args.reviewers);
                    case "publishDraftPullRequest":
                        return await this.publishDraftPullRequest(args.workspace, args.repo_slug, args.pull_request_id);
                    case "convertTodraft":
                        return await this.convertTodraft(args.workspace, args.repo_slug, args.pull_request_id);
                    case "getPendingReviewPRs":
                        return await this.getPendingReviewPRs(args.workspace, args.limit, args.repositoryList, args.reviewer);
                    case "listPipelineRuns":
                        return await this.listPipelineRuns(args.workspace, args.repo_slug, args.pagelen, args.page, args.all, args.status, args.target_branch, args.trigger_type, args.limit, args.sort);
                    case "getPipelineRun":
                        return await this.getPipelineRun(args.workspace, args.repo_slug, args.pipeline_uuid);
                    case "runPipeline":
                        return await this.runPipeline(args.workspace, args.repo_slug, args.target, args.variables);
                    case "stopPipeline":
                        return await this.stopPipeline(args.workspace, args.repo_slug, args.pipeline_uuid);
                    case "getPipelineSteps":
                        return await this.getPipelineSteps(args.workspace, args.repo_slug, args.pipeline_uuid, args.pagelen, args.page, args.all);
                    case "getPipelineStep":
                        return await this.getPipelineStep(args.workspace, args.repo_slug, args.pipeline_uuid, args.step_uuid);
                    case "getPipelineStepLogs":
                        return await this.getPipelineStepLogs(args.workspace, args.repo_slug, args.pipeline_uuid, args.step_uuid, args.max_lines, args.tail, args.errors_only, args.search_term, args.save_to_file);
                    case "getPullRequestComment":
                        return await this.getPullRequestComment(args.workspace, args.repo_slug, args.pull_request_id, args.comment_id);
                    case "updatePullRequestComment":
                        return await this.updatePullRequestComment(args.workspace, args.repo_slug, args.pull_request_id, args.comment_id, args.content);
                    case "deletePullRequestComment":
                        return await this.deletePullRequestComment(args.workspace, args.repo_slug, args.pull_request_id, args.comment_id);
                    case "resolveComment":
                        return await this.setCommentResolved(args.workspace, args.repo_slug, args.pull_request_id, args.comment_id, true);
                    case "reopenComment":
                        return await this.setCommentResolved(args.workspace, args.repo_slug, args.pull_request_id, args.comment_id, false);
                    case "getPullRequestDiffStat":
                        return await this.getPullRequestDiffStat(args.workspace, args.repo_slug, args.pull_request_id, args.pagelen, args.page, args.all);
                    case "getPullRequestPatch":
                        return await this.getPullRequestPatch(args.workspace, args.repo_slug, args.pull_request_id);
                    case "getPullRequestTasks":
                        return await this.getPullRequestTasks(args.workspace, args.repo_slug, args.pull_request_id, args.pagelen, args.page, args.all);
                    case "createPullRequestTask":
                        return await this.createPullRequestTask(args.workspace, args.repo_slug, args.pull_request_id, args.content, args.comment, args.state);
                    case "getPullRequestTask":
                        return await this.getPullRequestTask(args.workspace, args.repo_slug, args.pull_request_id, args.task_id);
                    case "updatePullRequestTask":
                        return await this.updatePullRequestTask(args.workspace, args.repo_slug, args.pull_request_id, args.task_id, args.content, args.state);
                    case "deletePullRequestTask":
                        return await this.deletePullRequestTask(args.workspace, args.repo_slug, args.pull_request_id, args.task_id);
                    case "getPullRequestStatuses":
                        return await this.getPullRequestStatuses(args.workspace, args.repo_slug, args.pull_request_id, args.pagelen, args.page, args.all);
                    case "getEffectiveDefaultReviewers":
                        return await this.getEffectiveDefaultReviewers(args.workspace, args.repo_slug);
                    default:
                        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
                }
            }
            catch (error) {
                logger.error("Tool execution error", {
                    error: sanitizeForLog(error),
                });
                if (axios.isAxiosError(error)) {
                    throw new McpError(ErrorCode.InternalError, `Bitbucket API error: ${error.response?.data.message ?? error.message}`);
                }
                throw error;
            }
        });
    }
    async listRepositories(workspace, pagelen, page, all, name, legacyLimit) {
        try {
            // Use default workspace if not provided
            const wsName = workspace || this.config.defaultWorkspace;
            if (!wsName) {
                throw new McpError(ErrorCode.InvalidParams, "Workspace must be provided either as a parameter or through BITBUCKET_WORKSPACE environment variable");
            }
            logger.info("Listing Bitbucket repositories", {
                workspace: wsName,
                pagelen: pagelen ?? legacyLimit,
                page,
                all,
                name,
            });
            const params = {};
            if (name) {
                params.q = buildRepositoryNameFilter(name);
            }
            const repositories = await this.paginator.fetchValues(`/repositories/${encodePathSegment(wsName)}`, {
                pagelen: pagelen ?? legacyLimit,
                page,
                all,
                params,
                description: "listRepositories",
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(repositories.values, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error listing repositories", { error: sanitizeForLog(error), workspace, name });
            throw new McpError(ErrorCode.InternalError, `Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getRepository(workspace, repo_slug) {
        try {
            logger.info("Getting Bitbucket repository info", {
                workspace,
                repo_slug,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting repository", { error: sanitizeForLog(error), workspace, repo_slug });
            throw new McpError(ErrorCode.InternalError, `Failed to get repository: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getEffectiveDefaultReviewers(workspace, repo_slug) {
        try {
            logger.info("Getting effective default reviewers", {
                workspace,
                repo_slug,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/effective-default-reviewers`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting effective default reviewers", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get effective default reviewers: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequests(workspace, repo_slug, state, pagelen, page, all, legacyLimit) {
        try {
            logger.info("Getting Bitbucket pull requests", {
                workspace,
                repo_slug,
                state,
                pagelen: pagelen ?? legacyLimit,
                page,
                all,
            });
            const params = {};
            if (state) {
                params.state = state;
            }
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests`, {
                pagelen: pagelen ?? legacyLimit,
                page,
                all,
                params,
                description: "getPullRequests",
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result.values, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull requests", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull requests: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async createPullRequest(workspace, repo_slug, title, description, sourceBranch, targetBranch, reviewers, draft) {
        try {
            logger.info("Creating Bitbucket pull request", {
                workspace,
                repo_slug,
                title,
                sourceBranch,
                targetBranch,
            });
            // Prepare reviewers format if provided
            // Bitbucket API expects reviewers as array of objects: [{uuid: "{...}"}]
            // Input is string array of UUIDs: ["{04776764-62c7-453b-b97e-302f60395ceb}", ...]
            // Convert to API format: [{uuid: "{...}"}, ...]
            let reviewersArray;
            if (reviewers && reviewers.length > 0) {
                reviewersArray = reviewers
                    .filter((uuid) => typeof uuid === "string" && uuid.trim().length > 0)
                    .map((uuid) => ({ uuid: uuid.trim() }));
                if (reviewersArray.length === 0) {
                    reviewersArray = undefined;
                }
            }
            // Build request payload - only include reviewers if provided
            const requestPayload = {
                title,
                description,
                source: {
                    branch: {
                        name: sourceBranch,
                    },
                },
                destination: {
                    branch: {
                        name: targetBranch,
                    },
                },
                close_source_branch: true,
            };
            // Only include reviewers field if there are reviewers to add
            if (reviewersArray && reviewersArray.length > 0) {
                requestPayload.reviewers = reviewersArray;
            }
            // Only include draft field if explicitly set to true
            if (draft === true) {
                requestPayload.draft = true;
            }
            // Create the pull request
            const response = await this.api.post(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests`, requestPayload);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error creating pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to create pull request: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequest(workspace, repo_slug, pull_request_id) {
        try {
            logger.info("Getting Bitbucket pull request details", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request details", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request details: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async updatePullRequest(workspace, repo_slug, pull_request_id, title, description) {
        try {
            logger.info("Updating Bitbucket pull request", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            // Only include fields that are provided
            const updateData = {};
            if (title !== undefined)
                updateData.title = title;
            if (description !== undefined)
                updateData.description = description;
            const response = await this.api.put(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}`, updateData);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error updating pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to update pull request: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestActivity(workspace, repo_slug, pull_request_id, pagelen, page, all) {
        try {
            logger.info("Getting Bitbucket pull request activity", {
                workspace,
                repo_slug,
                pull_request_id,
                pagelen,
                page,
                all,
            });
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/activity`, {
                pagelen,
                page,
                all,
                description: "getPullRequestActivity",
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result.values, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request activity", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request activity: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async approvePullRequest(workspace, repo_slug, pull_request_id) {
        try {
            logger.info("Approving Bitbucket pull request", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            // Bitbucket Cloud returns 400 when this POST carries no body or no
            // Content-Type. Pass `{}` so axios infers `application/json`.
            const response = await this.api.post(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/approve`, {});
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error approving pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to approve pull request: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async unapprovePullRequest(workspace, repo_slug, pull_request_id) {
        try {
            logger.info("Unapproving Bitbucket pull request", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            const response = await this.api.delete(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/approve`);
            return {
                content: [
                    {
                        type: "text",
                        text: "Pull request approval removed successfully.",
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error unapproving pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to unapprove pull request: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async declinePullRequest(workspace, repo_slug, pull_request_id, message) {
        try {
            logger.info("Declining Bitbucket pull request", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            // Include message if provided
            const data = message ? { message } : {};
            const response = await this.api.post(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/decline`, data);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error declining pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to decline pull request: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async mergePullRequest(workspace, repo_slug, pull_request_id, message, strategy) {
        try {
            logger.info("Merging Bitbucket pull request", {
                workspace,
                repo_slug,
                pull_request_id,
                strategy,
            });
            // Build request data
            const data = {};
            if (message)
                data.message = message;
            if (strategy)
                data.merge_strategy = strategy;
            const response = await this.api.post(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/merge`, data);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error merging pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to merge pull request: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestComments(workspace, repo_slug, pull_request_id, pagelen, page, all) {
        try {
            logger.info("Getting Bitbucket pull request comments", {
                workspace,
                repo_slug,
                pull_request_id,
                pagelen,
                page,
                all,
            });
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/comments`, {
                pagelen,
                page,
                all,
                description: "getPullRequestComments",
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result.values, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request comments", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request comments: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestDiff(workspace, repo_slug, pull_request_id) {
        try {
            logger.info("Getting Bitbucket pull request diff", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            // First get the pull request details to extract commit information
            const prResponse = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}`);
            const sourceCommit = prResponse.data.source.commit.hash;
            const destinationCommit = prResponse.data.destination.commit.hash;
            // Construct the correct diff URL with the proper format
            // The format is: /repositories/{workspace}/{repo_slug}/diff/{source_repo}:{source_commit}%0D{destination_commit}?from_pullrequest_id={pr_id}&topic=true
            const diffUrl = `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/diff/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}:${sourceCommit}%0D${destinationCommit}?from_pullrequest_id=${encodePathSegment(pull_request_id)}&topic=true`;
            const response = await this.api.get(diffUrl, {
                headers: {
                    Accept: "text/plain",
                },
                responseType: "text",
                maxRedirects: 5, // Enable redirect following
            });
            return {
                content: [
                    {
                        type: "text",
                        text: response.data,
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request diff", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request diff: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestCommits(workspace, repo_slug, pull_request_id, pagelen, page, all) {
        try {
            logger.info("Getting Bitbucket pull request commits", {
                workspace,
                repo_slug,
                pull_request_id,
                pagelen,
                page,
                all,
            });
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/commits`, {
                pagelen,
                page,
                all,
                description: "getPullRequestCommits",
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result.values, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request commits", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request commits: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async addPullRequestComment(workspace, repo_slug, pull_request_id, content, inline, pending, parent_id) {
        try {
            logger.info("Adding comment to Bitbucket pull request", {
                workspace,
                repo_slug,
                pull_request_id,
                mode: parent_id
                    ? "threaded reply"
                    : inline
                        ? "inline comment"
                        : "general comment",
            });
            // Prepare the comment data
            const commentData = {
                content: {
                    raw: content,
                },
            };
            // Add pending flag if provided
            if (pending !== undefined) {
                commentData.pending = pending;
            }
            // Threaded reply: inherit the parent's inline anchor; ignore any `inline`
            // arg the caller supplied to avoid Bitbucket 400s from conflicting anchors.
            if (parent_id !== undefined && parent_id !== null) {
                commentData.parent = { id: parent_id };
            }
            else if (inline) {
                commentData.inline = {
                    path: inline.path,
                };
                if (inline.from !== undefined) {
                    commentData.inline.from = inline.from;
                }
                if (inline.to !== undefined) {
                    commentData.inline.to = inline.to;
                }
            }
            const response = await this.api.post(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/comments`, commentData);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error adding comment to pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to add pull request comment: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getRepositoryBranchingModel(workspace, repo_slug) {
        try {
            logger.info("Getting repository branching model", {
                workspace,
                repo_slug,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/branching-model`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting repository branching model", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get repository branching model: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getRepositoryBranchingModelSettings(workspace, repo_slug) {
        try {
            logger.info("Getting repository branching model settings", {
                workspace,
                repo_slug,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/branching-model/settings`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting repository branching model settings", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get repository branching model settings: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async updateRepositoryBranchingModelSettings(workspace, repo_slug, development, production, branch_types) {
        try {
            logger.info("Updating repository branching model settings", {
                workspace,
                repo_slug,
                development,
                production,
                branch_types,
            });
            // Build request data with only the fields that are provided
            const updateData = {};
            if (development)
                updateData.development = development;
            if (production)
                updateData.production = production;
            if (branch_types)
                updateData.branch_types = branch_types;
            const response = await this.api.put(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/branching-model/settings`, updateData);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error updating repository branching model settings", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to update repository branching model settings: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getEffectiveRepositoryBranchingModel(workspace, repo_slug) {
        try {
            logger.info("Getting effective repository branching model", {
                workspace,
                repo_slug,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/effective-branching-model`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting effective repository branching model", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get effective repository branching model: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getProjectBranchingModel(workspace, project_key) {
        try {
            logger.info("Getting project branching model", {
                workspace,
                project_key,
            });
            const response = await this.api.get(`/workspaces/${encodePathSegment(workspace)}/projects/${encodePathSegment(project_key)}/branching-model`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting project branching model", {
                error: sanitizeForLog(error),
                workspace,
                project_key,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get project branching model: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getProjectBranchingModelSettings(workspace, project_key) {
        try {
            logger.info("Getting project branching model settings", {
                workspace,
                project_key,
            });
            const response = await this.api.get(`/workspaces/${encodePathSegment(workspace)}/projects/${encodePathSegment(project_key)}/branching-model/settings`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting project branching model settings", {
                error: sanitizeForLog(error),
                workspace,
                project_key,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get project branching model settings: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async updateProjectBranchingModelSettings(workspace, project_key, development, production, branch_types) {
        try {
            logger.info("Updating project branching model settings", {
                workspace,
                project_key,
                development,
                production,
                branch_types,
            });
            // Build request data with only the fields that are provided
            const updateData = {};
            if (development)
                updateData.development = development;
            if (production)
                updateData.production = production;
            if (branch_types)
                updateData.branch_types = branch_types;
            const response = await this.api.put(`/workspaces/${encodePathSegment(workspace)}/projects/${encodePathSegment(project_key)}/branching-model/settings`, updateData);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error updating project branching model settings", {
                error: sanitizeForLog(error),
                workspace,
                project_key,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to update project branching model settings: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async addPendingPullRequestComment(workspace, repo_slug, pull_request_id, content, inline) {
        try {
            logger.info("Adding pending comment to Bitbucket pull request", {
                workspace,
                repo_slug,
                pull_request_id,
                inline: inline ? "inline comment" : "general comment",
            });
            // Use the existing addPullRequestComment method with pending=true
            return await this.addPullRequestComment(workspace, repo_slug, pull_request_id, content, inline, true // Set pending to true for draft comment
            );
        }
        catch (error) {
            logger.error("Error adding pending comment to pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to add pending pull request comment: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async publishPendingComments(workspace, repo_slug, pull_request_id) {
        try {
            logger.info("Publishing pending comments for Bitbucket pull request", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            // First, get all pending comments for the pull request
            const commentsResult = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/comments`, {
                pagelen: BITBUCKET_MAX_PAGELEN,
                all: true,
                description: "publishPendingComments",
            });
            const comments = (commentsResult.values || []);
            const pendingComments = comments.filter((comment) => comment.pending === true);
            if (pendingComments.length === 0) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No pending comments found to publish.",
                        },
                    ],
                };
            }
            // Publish each pending comment by updating it with pending=false
            const publishResults = [];
            for (const comment of pendingComments) {
                try {
                    const updateResponse = await this.api.put(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/comments/${encodePathSegment(String(comment.id))}`, {
                        content: comment.content,
                        pending: false,
                        ...(comment.inline && { inline: comment.inline }),
                    });
                    publishResults.push({
                        commentId: comment.id,
                        status: "published",
                        data: updateResponse.data,
                    });
                }
                catch (error) {
                    publishResults.push({
                        commentId: comment.id,
                        status: "error",
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            message: `Published ${pendingComments.length} pending comments`,
                            results: publishResults,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error publishing pending comments", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to publish pending comments: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async createDraftPullRequest(workspace, repo_slug, title, description, sourceBranch, targetBranch, reviewers) {
        try {
            logger.info("Creating draft Bitbucket pull request", {
                workspace,
                repo_slug,
                title,
                sourceBranch,
                targetBranch,
            });
            // Use the existing createPullRequest method with draft=true
            return await this.createPullRequest(workspace, repo_slug, title, description, sourceBranch, targetBranch, reviewers, true // Set draft to true
            );
        }
        catch (error) {
            logger.error("Error creating draft pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to create draft pull request: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async publishDraftPullRequest(workspace, repo_slug, pull_request_id) {
        try {
            logger.info("Publishing draft pull request", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            // Update the pull request to set draft=false
            const response = await this.api.put(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}`, {
                draft: false,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error publishing draft pull request", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to publish draft pull request: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async convertTodraft(workspace, repo_slug, pull_request_id) {
        try {
            logger.info("Converting pull request to draft", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            // Update the pull request to set draft=true
            const response = await this.api.put(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}`, {
                draft: true,
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error converting pull request to draft", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to convert pull request to draft: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async resolveCurrentUserNickname() {
        try {
            const response = await this.api.get("/user");
            const user = response.data;
            const nickname = user.nickname || user.username;
            return typeof nickname === "string" && nickname.trim().length > 0
                ? nickname.trim()
                : undefined;
        }
        catch (error) {
            logger.error("Failed to resolve current user from GET /user", {
                error: sanitizeForLog(error),
            });
            return undefined;
        }
    }
    async getPendingReviewPRs(workspace, limit = 50, repositoryList, reviewer) {
        try {
            const wsName = workspace || this.config.defaultWorkspace;
            if (!wsName) {
                throw new McpError(ErrorCode.InvalidParams, "Workspace must be provided either as a parameter or through BITBUCKET_WORKSPACE environment variable");
            }
            const currentUserNickname = reviewer?.trim() || (await this.resolveCurrentUserNickname());
            if (!currentUserNickname) {
                throw new McpError(ErrorCode.InvalidParams, "Could not resolve the reviewer. Pass reviewer, or use a user-scoped access token that can call GET /user.");
            }
            logger.info("Getting pending review PRs", {
                workspace: wsName,
                reviewer: currentUserNickname,
                repositoryList: repositoryList?.length || "all repositories",
                limit,
            });
            let repositoriesToCheck = [];
            if (repositoryList && repositoryList.length > 0) {
                // Use the provided repository list
                repositoriesToCheck = repositoryList;
                logger.info(`Checking specific repositories: ${repositoryList.join(", ")}`);
            }
            else {
                // Get all repositories in the workspace (existing behavior)
                logger.info("Getting all repositories in workspace...");
                const reposResponse = await this.paginator.fetchValues(`/repositories/${encodePathSegment(wsName)}`, {
                    pagelen: BITBUCKET_MAX_PAGELEN,
                    all: true,
                    description: "getPendingReviewPRs.repositories",
                });
                if (!reposResponse.values) {
                    throw new McpError(ErrorCode.InternalError, "Failed to fetch repositories");
                }
                repositoriesToCheck = reposResponse.values.map((repo) => repo.name);
                logger.info(`Found ${repositoriesToCheck.length} repositories to check`);
            }
            const pendingPRs = [];
            const batchSize = 5; // Process repositories in batches to avoid overwhelming the API
            // Process repositories in batches
            for (let i = 0; i < repositoriesToCheck.length; i += batchSize) {
                const batch = repositoriesToCheck.slice(i, i + batchSize);
                // Process batch in parallel
                const batchPromises = batch.map(async (repoSlug) => {
                    try {
                        logger.info(`Checking repository: ${repoSlug}`);
                        // Get open PRs for this repository with participants expanded
                        const prsResponse = await this.api.get(`/repositories/${encodePathSegment(wsName)}/${encodePathSegment(repoSlug)}/pullrequests`, {
                            params: {
                                state: "OPEN",
                                pagelen: Math.min(limit, 50), // Limit per repo to avoid too much data
                                fields: "values.id,values.title,values.description,values.state,values.created_on,values.updated_on,values.author,values.source,values.destination,values.participants.user.nickname,values.participants.role,values.participants.approved,values.links",
                            },
                        });
                        if (!prsResponse.data.values) {
                            return [];
                        }
                        // Filter PRs where current user is a reviewer and hasn't approved
                        const reposPendingPRs = prsResponse.data.values.filter((pr) => {
                            if (!pr.participants || !Array.isArray(pr.participants)) {
                                logger.debug(`PR ${pr.id} has no participants array`);
                                return false;
                            }
                            logger.debug(`PR ${pr.id} participants:`, pr.participants.map((p) => ({
                                nickname: p.user?.nickname,
                                role: p.role,
                                approved: p.approved,
                            })));
                            // Check if current user is a reviewer who hasn't approved
                            const userParticipant = pr.participants.find((participant) => participant.user?.nickname === currentUserNickname &&
                                participant.role === "REVIEWER" &&
                                participant.approved === false);
                            logger.debug(`PR ${pr.id} - User ${currentUserNickname} is pending reviewer:`, !!userParticipant);
                            return !!userParticipant;
                        });
                        // Add repository info to each PR
                        return reposPendingPRs.map((pr) => ({
                            ...pr,
                            repository: {
                                name: repoSlug,
                                full_name: `${wsName}/${repoSlug}`,
                            },
                        }));
                    }
                    catch (error) {
                        logger.error(`Error checking repository ${repoSlug}:`, {
                            error: sanitizeForLog(error),
                        });
                        return [];
                    }
                });
                // Wait for batch to complete
                const batchResults = await Promise.all(batchPromises);
                // Flatten and add to results
                for (const repoPRs of batchResults) {
                    pendingPRs.push(...repoPRs);
                    // Stop if we've reached the limit
                    if (pendingPRs.length >= limit) {
                        break;
                    }
                }
                // Stop processing if we've reached the limit
                if (pendingPRs.length >= limit) {
                    break;
                }
            }
            // Trim to exact limit and sort by updated date
            const finalResults = pendingPRs
                .slice(0, limit)
                .sort((a, b) => new Date(b.updated_on).getTime() - new Date(a.updated_on).getTime());
            logger.info(`Found ${finalResults.length} pending review PRs`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            pending_review_prs: finalResults,
                            total_found: finalResults.length,
                            searched_repositories: repositoriesToCheck.length,
                            user: currentUserNickname,
                            workspace: wsName,
                        }, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pending review PRs:", { error: sanitizeForLog(error) });
            throw new McpError(ErrorCode.InternalError, `Failed to get pending review PRs: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    // =========== PIPELINE METHODS ===========
    async listPipelineRuns(workspace, repo_slug, pagelen, page, all, status, target_branch, trigger_type, legacyLimit, sort) {
        try {
            logger.info("Listing pipeline runs", {
                workspace,
                repo_slug,
                pagelen: pagelen ?? legacyLimit,
                page,
                all,
                status,
                target_branch,
                trigger_type,
                sort,
            });
            const params = {};
            if (status)
                params.status = status;
            if (target_branch)
                params["target.branch"] = target_branch;
            if (trigger_type)
                params.trigger_type = trigger_type;
            if (sort)
                params.sort = sort;
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pipelines`, {
                pagelen: pagelen ?? legacyLimit,
                page,
                all,
                params,
                description: "listPipelineRuns",
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result.values, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error listing pipeline runs", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to list pipeline runs: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPipelineRun(workspace, repo_slug, pipeline_uuid) {
        try {
            logger.info("Getting pipeline run details", {
                workspace,
                repo_slug,
                pipeline_uuid,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pipelines/${encodePathSegment(pipeline_uuid)}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pipeline run", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pipeline_uuid,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pipeline run: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async runPipeline(workspace, repo_slug, target, variables) {
        try {
            logger.info("Triggering pipeline run", {
                workspace,
                repo_slug,
                target,
                variables: variables?.length || 0,
            });
            // Build the target object based on the input
            const pipelineTarget = {
                type: target.commit_hash
                    ? "pipeline_commit_target"
                    : "pipeline_ref_target",
                ref_type: target.ref_type,
                ref_name: target.ref_name,
            };
            // Add commit if specified
            if (target.commit_hash) {
                pipelineTarget.commit = {
                    type: "commit",
                    hash: target.commit_hash,
                };
            }
            // Add selector if specified
            if (target.selector_type && target.selector_pattern) {
                pipelineTarget.selector = {
                    type: target.selector_type,
                    pattern: target.selector_pattern,
                };
            }
            // Build the request data
            const requestData = {
                target: pipelineTarget,
            };
            // Add variables if provided
            if (variables && variables.length > 0) {
                requestData.variables = variables.map((variable) => ({
                    key: variable.key,
                    value: variable.value,
                    secured: variable.secured || false,
                }));
            }
            const response = await this.api.post(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pipelines`, requestData);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error running pipeline", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to run pipeline: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async stopPipeline(workspace, repo_slug, pipeline_uuid) {
        try {
            logger.info("Stopping pipeline", {
                workspace,
                repo_slug,
                pipeline_uuid,
            });
            // Bitbucket Cloud returns 400 when this POST carries no body or no
            // Content-Type. Pass `{}` so axios infers `application/json`.
            const response = await this.api.post(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pipelines/${encodePathSegment(pipeline_uuid)}/stop`, {});
            return {
                content: [
                    {
                        type: "text",
                        text: "Pipeline stop signal sent successfully.",
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error stopping pipeline", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pipeline_uuid,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to stop pipeline: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPipelineSteps(workspace, repo_slug, pipeline_uuid, pagelen, page, all) {
        try {
            logger.info("Getting pipeline steps", {
                workspace,
                repo_slug,
                pipeline_uuid,
                pagelen,
                page,
                all,
            });
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pipelines/${encodePathSegment(pipeline_uuid)}/steps`, {
                pagelen,
                page,
                all,
                description: "getPipelineSteps",
            });
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(result.values, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pipeline steps", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pipeline_uuid,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pipeline steps: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPipelineStep(workspace, repo_slug, pipeline_uuid, step_uuid) {
        try {
            logger.info("Getting pipeline step details", {
                workspace,
                repo_slug,
                pipeline_uuid,
                step_uuid,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pipelines/${encodePathSegment(pipeline_uuid)}/steps/${encodePathSegment(step_uuid)}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pipeline step", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pipeline_uuid,
                step_uuid,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pipeline step: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPipelineStepLogs(workspace, repo_slug, pipeline_uuid, step_uuid, maxLines, tail, errorsOnly, searchTerm, saveToFile) {
        try {
            logger.info("Getting pipeline step logs", {
                workspace,
                repo_slug,
                pipeline_uuid,
                step_uuid,
                maxLines,
                tail,
                errorsOnly,
                searchTerm,
                saveToFile,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pipelines/${encodePathSegment(pipeline_uuid)}/steps/${encodePathSegment(step_uuid)}/log`, {
                maxRedirects: 5, // Follow redirects to S3
                responseType: "text",
            });
            const rawLog = typeof response.data === "string"
                ? response.data
                : response.data === undefined || response.data === null
                    ? ""
                    : String(response.data);
            const allLines = rawLog.length > 0 ? rawLog.split(/\r?\n/) : [];
            const totalLines = allLines.length;
            let filteredLines = allLines;
            const normalizedSearch = searchTerm?.trim().toLowerCase();
            if (errorsOnly) {
                const errorRegex = /(error|failed|failure|exception|traceback|fatal)/i;
                filteredLines = filteredLines.filter((line) => errorRegex.test(line));
            }
            if (normalizedSearch && normalizedSearch.length > 0) {
                filteredLines = filteredLines.filter((line) => line.toLowerCase().includes(normalizedSearch));
            }
            const defaultMaxLines = 500;
            const normalizedMaxLines = typeof maxLines === "number" && Number.isFinite(maxLines)
                ? Math.floor(maxLines)
                : defaultMaxLines;
            const resolvedMaxLines = Math.max(1, Math.min(normalizedMaxLines, 5000));
            const hasLines = filteredLines.length > 0;
            const limitedLines = hasLines
                ? tail
                    ? filteredLines.slice(-resolvedMaxLines)
                    : filteredLines.slice(0, resolvedMaxLines)
                : [];
            const wasTruncated = hasLines && filteredLines.length > limitedLines.length;
            const summaryParts = [`Total log lines: ${totalLines}.`];
            if (errorsOnly || (normalizedSearch && normalizedSearch.length > 0)) {
                summaryParts.push(`Lines after filtering: ${filteredLines.length}.`);
            }
            if (!hasLines) {
                summaryParts.push("No log lines matched the provided filters.");
            }
            else {
                summaryParts.push(`Showing ${limitedLines.length} ${tail ? "most recent" : "earliest"} lines${wasTruncated ? ` (limited to ${resolvedMaxLines} lines)` : ""}.`);
            }
            if (saveToFile) {
                try {
                    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bitbucket-mcp-"));
                    const safeFileName = `pipeline-${pipeline_uuid}-step-${step_uuid}.log`.replace(/[^a-zA-Z0-9._-]/g, "_");
                    const filePath = path.join(tempDir, safeFileName);
                    fs.writeFileSync(filePath, rawLog, "utf8");
                    summaryParts.push(`Full log saved to: ${filePath}`);
                }
                catch (fileError) {
                    logger.warn("Failed to save pipeline step log to file", {
                        error: sanitizeForLog(fileError),
                    });
                    summaryParts.push("Attempted to save the full log to a temporary file, but writing failed.");
                }
            }
            if (!saveToFile && wasTruncated) {
                summaryParts.push("Use max_lines, tail, search_term, or save_to_file to refine or download the full log.");
            }
            const summary = summaryParts.join(" ");
            const textContent = hasLines
                ? `${summary}\n\n${limitedLines.join("\n")}`
                : summary;
            return {
                content: [
                    {
                        type: "text",
                        text: textContent,
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pipeline step logs", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pipeline_uuid,
                step_uuid,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pipeline step logs: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestComment(workspace, repo_slug, pull_request_id, comment_id) {
        try {
            logger.info("Getting pull request comment", {
                workspace,
                repo_slug,
                pull_request_id,
                comment_id,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/comments/${encodePathSegment(comment_id)}`);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(response.data, null, 2),
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request comment", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
                comment_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request comment: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async updatePullRequestComment(workspace, repo_slug, pull_request_id, comment_id, content) {
        try {
            logger.info("Updating pull request comment", {
                workspace,
                repo_slug,
                pull_request_id,
                comment_id,
            });
            const response = await this.api.put(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/comments/${encodePathSegment(comment_id)}`, {
                content: { raw: content },
            });
            return {
                content: [
                    { type: "text", text: JSON.stringify(response.data, null, 2) },
                ],
            };
        }
        catch (error) {
            logger.error("Error updating pull request comment", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
                comment_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to update pull request comment: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async deletePullRequestComment(workspace, repo_slug, pull_request_id, comment_id) {
        try {
            logger.info("Deleting pull request comment", {
                workspace,
                repo_slug,
                pull_request_id,
                comment_id,
            });
            await this.api.delete(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/comments/${encodePathSegment(comment_id)}`);
            return {
                content: [{ type: "text", text: "Comment deleted successfully." }],
            };
        }
        catch (error) {
            logger.error("Error deleting pull request comment", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
                comment_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to delete pull request comment: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async setCommentResolved(workspace, repo_slug, pull_request_id, comment_id, resolved) {
        try {
            logger.info("Setting comment resolved state", {
                workspace,
                repo_slug,
                pull_request_id,
                comment_id,
                resolved,
            });
            const commentUrl = (id) => `/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/comments/${encodePathSegment(String(id))}`;
            const resolveUrl = (id) => `${commentUrl(id)}/resolve`;
            // Bitbucket resolves comment *threads*, and the API expects the thread root comment ID.
            // If the provided comment_id is a reply, walk up the parent chain to find the root.
            let targetCommentId = comment_id;
            try {
                const visited = new Set();
                for (let depth = 0; depth < 25; depth++) {
                    if (visited.has(targetCommentId))
                        break;
                    visited.add(targetCommentId);
                    const commentResponse = await this.api.get(commentUrl(targetCommentId));
                    const parentId = commentResponse.data?.parent?.id;
                    if (parentId === undefined || parentId === null)
                        break;
                    targetCommentId = String(parentId);
                }
            }
            catch (lookupError) {
                // If we fail to look up the comment hierarchy, still attempt to resolve the provided ID.
                logger.warn("Failed to resolve comment thread root; falling back to comment_id", {
                    error: sanitizeForLog(lookupError),
                    workspace,
                    repo_slug,
                    pull_request_id,
                    comment_id,
                });
                targetCommentId = comment_id;
            }
            // Bitbucket Cloud requires POST /resolve to carry a JSON body (at minimum `{}`)
            // and a matching Content-Type header; otherwise the gateway returns 400.
            // Pass an explicit empty-object body so axios sets `Content-Type: application/json`.
            const response = resolved
                ? await this.api.post(resolveUrl(targetCommentId), {})
                : await this.api.delete(resolveUrl(targetCommentId));
            const responseText = response.data === undefined ||
                response.data === null ||
                response.data === ""
                ? resolved
                    ? `Comment thread resolved (comment_id: ${targetCommentId}).`
                    : `Comment thread reopened (comment_id: ${targetCommentId}).`
                : JSON.stringify(response.data, null, 2);
            return {
                content: [
                    {
                        type: "text",
                        text: responseText,
                    },
                ],
            };
        }
        catch (error) {
            logger.error("Error setting comment resolved state", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
                comment_id,
                resolved,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to update comment resolved state: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestDiffStat(workspace, repo_slug, pull_request_id, pagelen, page, all) {
        try {
            logger.info("Getting pull request diffstat", {
                workspace,
                repo_slug,
                pull_request_id,
                pagelen,
                page,
                all,
            });
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/diffstat`, {
                pagelen,
                page,
                all,
                description: "getPullRequestDiffStat",
            });
            return {
                content: [
                    { type: "text", text: JSON.stringify(result.values, null, 2) },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request diffstat", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request diffstat: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestPatch(workspace, repo_slug, pull_request_id) {
        try {
            logger.info("Getting pull request patch", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            const response = await this.api.get(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/patch`, {
                headers: { Accept: "text/plain" },
                responseType: "text",
                maxRedirects: 5,
            });
            return { content: [{ type: "text", text: response.data }] };
        }
        catch (error) {
            logger.error("Error getting pull request patch", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request patch: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestTasks(workspace, repo_slug, pull_request_id, pagelen, page, all) {
        try {
            logger.info("Getting pull request tasks", {
                workspace,
                repo_slug,
                pull_request_id,
                pagelen,
                page,
                all,
            });
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/tasks`, {
                pagelen,
                page,
                all,
                description: "getPullRequestTasks",
            });
            return {
                content: [
                    { type: "text", text: JSON.stringify(result.values, null, 2) },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request tasks", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request tasks: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async createPullRequestTask(workspace, repo_slug, pull_request_id, content, commentId, state) {
        try {
            logger.info("Creating pull request task", {
                workspace,
                repo_slug,
                pull_request_id,
            });
            const data = { content };
            if (commentId)
                data.comment = { id: commentId };
            if (state)
                data.state = state;
            const response = await this.api.post(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/tasks`, data);
            return {
                content: [
                    { type: "text", text: JSON.stringify(response.data, null, 2) },
                ],
            };
        }
        catch (error) {
            logger.error("Error creating pull request task", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to create pull request task: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestTask(workspace, repo_slug, pull_request_id, task_id) {
        try {
            logger.info("Getting pull request task", {
                workspace,
                repo_slug,
                pull_request_id,
                task_id,
            });
            const response = await this.api.get(`/tasks/${encodePathSegment(task_id)}`);
            return {
                content: [
                    { type: "text", text: JSON.stringify(response.data, null, 2) },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request task", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
                task_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request task: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async updatePullRequestTask(workspace, repo_slug, pull_request_id, task_id, content, state) {
        try {
            logger.info("Updating pull request task", {
                workspace,
                repo_slug,
                pull_request_id,
                task_id,
            });
            const data = {};
            if (content !== undefined)
                data.content = content;
            if (state !== undefined)
                data.state = state;
            const response = await this.api.put(`/tasks/${encodePathSegment(task_id)}`, data);
            return {
                content: [
                    { type: "text", text: JSON.stringify(response.data, null, 2) },
                ],
            };
        }
        catch (error) {
            logger.error("Error updating pull request task", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
                task_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to update pull request task: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async deletePullRequestTask(workspace, repo_slug, pull_request_id, task_id) {
        try {
            logger.info("Deleting pull request task", {
                workspace,
                repo_slug,
                pull_request_id,
                task_id,
            });
            await this.api.delete(`/tasks/${encodePathSegment(task_id)}`);
            return {
                content: [{ type: "text", text: "Task deleted successfully." }],
            };
        }
        catch (error) {
            logger.error("Error deleting pull request task", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
                task_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to delete pull request task: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async getPullRequestStatuses(workspace, repo_slug, pull_request_id, pagelen, page, all) {
        try {
            logger.info("Getting pull request statuses", {
                workspace,
                repo_slug,
                pull_request_id,
                pagelen,
                page,
                all,
            });
            const result = await this.paginator.fetchValues(`/repositories/${encodePathSegment(workspace)}/${encodePathSegment(repo_slug)}/pullrequests/${encodePathSegment(pull_request_id)}/statuses`, {
                pagelen,
                page,
                all,
                description: "getPullRequestStatuses",
            });
            const payload = {
                values: result.values,
                page: result.page,
                pagelen: result.pagelen,
                next: result.next,
                previous: result.previous,
                fetchedPages: result.fetchedPages,
                totalFetched: result.totalFetched,
            };
            return {
                content: [
                    { type: "text", text: JSON.stringify(payload, null, 2) },
                ],
            };
        }
        catch (error) {
            logger.error("Error getting pull request statuses", {
                error: sanitizeForLog(error),
                workspace,
                repo_slug,
                pull_request_id,
            });
            throw new McpError(ErrorCode.InternalError, `Failed to get pull request statuses: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        logger.info("Bitbucket MCP server running on stdio");
    }
}
// Create and start the server
const server = new BitbucketServer();
server.run().catch((error) => {
    logger.error("Server error", { error: sanitizeForLog(error) });
    process.exit(1);
});
//# sourceMappingURL=index.js.map
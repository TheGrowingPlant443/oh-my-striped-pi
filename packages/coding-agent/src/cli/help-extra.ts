import "@oh-my-striped-pi/pi-utils/env";
import chalk from "@oh-my-striped-pi/pi-utils/chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "@oh-my-striped-pi/pi-utils/dirs";

export function getExtraHelpText(): string {
	return `${chalk.bold("Environment Variables:")}
  ${chalk.dim("# Model Provider")}
  COPILOT_GITHUB_TOKEN      - GitHub Copilot
  NODE_EXTRA_CA_CERTS       - CA bundle path (or inline PEM) for server certificate validation

  ${chalk.dim("# Search & Tools")}
  SEARXNG_ENDPOINT          - Self-hosted SearXNG base URL for web search
  SEARXNG_TOKEN             - Optional SearXNG bearer token
  FIRECRAWL_BASE_URL        - Explicit private Firecrawl endpoint for search and reader
  FIRECRAWL_API_URL         - Alias for FIRECRAWL_BASE_URL
  FIRECRAWL_API_KEY         - Optional key for the configured Firecrawl endpoint

  ${chalk.dim("# Configuration")}
  OMSP_PROFILE                 - Named profile for isolated agent state (same as --profile)
  Use \`omsp --profile <name> --alias <command>\` to create a shell shortcut for a profile
  OMSP_CODING_AGENT_DIR        - Session storage directory (default: ~/${CONFIG_DIR_NAME}/agent)
  OMSP_PACKAGE_DIR             - Override package directory (for Nix/Guix store paths)
  OMSP_SMOL_MODEL              - Override smol/fast model (see --smol)
  OMSP_SLOW_MODEL              - Override slow/reasoning model (see --slow)
  OMSP_PLAN_MODEL              - Override planning model (see --plan)
  OMSP_NO_PTY                  - Disable PTY-based interactive bash execution
  For complete environment variable reference, see:
  ${chalk.dim("docs/environment-variables.md")}
${chalk.bold("Available Tools (default-enabled unless noted):")}
  read          - Read file contents
  bash          - Execute bash commands
  edit          - Edit files with find/replace
  write         - Write files (creates/overwrites)
  grep          - Search file contents
  glob          - Find files by glob pattern
  lsp           - Language server protocol (code intelligence)
  python        - Execute Python code (requires: ${APP_NAME} setup python)
  notebook      - Edit Jupyter notebooks
  browser       - Browser automation (Puppeteer)
  computer      - Native host desktop capture and input (disabled by default)
  task          - Launch sub-agents for parallel tasks
  todo          - Manage todo/task lists
  web_search    - Search the web
  ask           - Ask user questions (interactive mode only)

${chalk.bold("Plugin Options:")}
  --plugin-dir <path>        Load plugin from directory (repeatable)

${chalk.bold("Useful Commands:")}
  omsp agents unpack           - Export bundled subagents to ~/.omsp/agent/agents (default)
  omsp agents unpack --project - Export bundled subagents to ./.omsp/agents`;
}

/**
 * `hanzi-browser setup` — auto-detect AI agents and inject MCP config.
 *
 * Scans the machine for Claude Code, Cursor, Windsurf, and Claude Desktop,
 * then merges the Hanzi MCP server entry into each agent's config file.
 */
interface AgentConfig {
    name: string;
    slug: string;
    method: 'json-merge' | 'cli-command';
    detect: () => boolean;
    configPath?: () => string;
    configSection?: 'mcpServers' | 'servers' | 'context_servers';
    legacyConfigSections?: ('mcpServers' | 'servers' | 'context_servers')[];
    cliCommand?: string;
    skillsDir?: () => string;
}
interface SetupResult {
    agent: string;
    status: 'configured' | 'already-configured' | 'skipped' | 'error';
    detail: string;
}
interface AgentRegistryDeps {
    home?: string;
    plat?: NodeJS.Platform;
    appData?: string;
    xdgConfigHome?: string;
    pathExists?: (path: string) => boolean;
    runCommand?: (command: string, options?: any) => Buffer | string;
}
interface JsonConfigDeps {
    pathExists?: (path: string) => boolean;
    readTextFile?: (path: string, encoding: BufferEncoding) => string;
    writeTextFile?: (path: string, contents: string) => void;
    ensureDir?: (path: string, options: {
        recursive: boolean;
    }) => void;
    copyFile?: (source: string, destination: string) => void;
}
interface BrowserDetectionDeps {
    plat?: NodeJS.Platform;
    pathExists?: (path: string) => boolean;
    runCommand?: (command: string, options?: any) => Buffer | string;
}
export declare function getAgentRegistry(deps?: AgentRegistryDeps): AgentConfig[];
export declare function mergeJsonConfig(configPath: string, deps?: JsonConfigDeps): SetupResult;
export declare function mergeJsonConfigAtKey(configPath: string, configSection: 'mcpServers' | 'servers' | 'context_servers', deps?: JsonConfigDeps, legacyConfigSections?: ('mcpServers' | 'servers' | 'context_servers')[]): SetupResult;
interface BrowserInfo {
    name: string;
    slug: string;
    macApp: string;
    linuxBin: string;
    winPaths: string[];
}
export declare function detectBrowsers(deps?: BrowserDetectionDeps): BrowserInfo[];
export declare function resolveInteractiveMode(options?: {
    yes?: boolean;
}, stdinIsTTY?: boolean): boolean;
export declare function buildBrowserOpenCommand(browser: BrowserInfo, url: string, plat: NodeJS.Platform): string;
export declare function buildSystemOpenCommand(url: string, plat: NodeJS.Platform): string;
export declare function runSetup(options?: {
    only?: string;
    yes?: boolean;
    all?: boolean;
    skills?: string[];
}): Promise<void>;
export {};

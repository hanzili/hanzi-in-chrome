/**
 * Domain-specific knowledge for the server-side agent loop.
 * Matches the extension's domain-skills.js but only includes domains
 * relevant to managed/API tasks.
 */
interface DomainEntry {
    domain: string;
    skill: string;
}
/**
 * Look up domain knowledge for a URL.
 * Returns the first matching entry, or null.
 */
export declare function getDomainSkill(url: string): DomainEntry | null;
export {};

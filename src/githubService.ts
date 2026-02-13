import * as vscode from 'vscode';

// ——————————————————————————————————————————————————————————————————————————————————————————
// GitHubService – Gist-backed workflow versioning using VS Code's built-in GitHub auth
// No OAuth plumbing needed — uses vscode.authentication provider
// ——————————————————————————————————————————————————————————————————————————————————————————

const GITHUB_API = 'https://api.github.com';
const GIST_DESCRIPTION_PREFIX = '[Ouroboros';
const VALID_GIST_DOC_TYPES = ['workflow', 'skill', 'playbook', 'recipe'];

export interface GistFile {
    filename: string;
    content: string;
    language?: string;
    size?: number;
}

export interface GistRevision {
    version: string;
    committed_at: string;
    change_status: { total: number; additions: number; deletions: number };
    url: string;
}

export interface GistInfo {
    id: string;
    url: string;           // html_url
    apiUrl: string;        // api url
    description: string;
    files: Record<string, GistFile>;
    owner: { login: string; avatar_url: string } | null;
    created_at: string;
    updated_at: string;
    public: boolean;
    forks_url: string;
    history?: GistRevision[];
}

export class GitHubService {
    private token: string | null = null;
    private username: string | null = null;
    private _onAuthChange = new vscode.EventEmitter<{ authenticated: boolean; username: string | null }>();
    public readonly onAuthChange = this._onAuthChange.event;

    constructor() {}

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // AUTHENTICATION (VS Code built-in GitHub provider)
    // ——————————————————————————————————————————————————————————————————————————————————————————

    get isAuthenticated(): boolean { return !!this.token; }
    get githubUsername(): string | null { return this.username; }

    async authenticate(silent: boolean = false): Promise<boolean> {
        try {
            const session = await vscode.authentication.getSession('github', ['gist'], {
                createIfNone: !silent
            });
            if (session) {
                this.token = session.accessToken;
                // Fetch username
                const user = await this.apiGet('/user');
                this.username = user.login || null;
                this._onAuthChange.fire({ authenticated: true, username: this.username });
                console.log('[GitHub] Authenticated as', this.username);
                return true;
            }
        } catch (err: any) {
            if (!silent) {
                console.warn('[GitHub] Auth failed:', err.message);
            }
        }
        return false;
    }

    async signOut(): Promise<void> {
        this.token = null;
        this.username = null;
        this._onAuthChange.fire({ authenticated: false, username: null });
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // GIST CRUD
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async createGist(
        name: string,
        bodyContent: string,
        description: string,
        isPublic: boolean = true,
        meta?: Record<string, any>
    ): Promise<GistInfo> {
        if (!this.token) { throw new Error('Not authenticated with GitHub'); }

        const docType = meta?.docType || 'workflow';
        const filename = this.slugify(name) + '.' + docType + '.json';
        const content: Record<string, any> = {
            name,
            description,
            docType,
            body: bodyContent,
            bodyFormat: meta?.bodyFormat || (docType === 'workflow' ? 'json' : 'text'),
            ...(meta || {}),
            _ouroboros: {
                version: meta?.version || '1.0.0',
                category: meta?.category || 'other',
                complexity: meta?.complexity || 'moderate',
                estTime: meta?.estTime || 'fast',
                docType,
                updatedAt: new Date().toISOString()
            }
        };
        // Backward compat: keep 'workflow' field for workflow type
        if (docType === 'workflow') { content.workflow = bodyContent; }

        const dtLabel = docType.charAt(0).toUpperCase() + docType.slice(1);
        const readmeContent = `# ${name}\n\n${description}\n\n` +
            `**Type:** ${dtLabel}\n` +
            `**Category:** ${meta?.category || 'other'}\n` +
            `**Version:** ${meta?.version || '1.0.0'}\n` +
            `**Complexity:** ${meta?.complexity || 'moderate'}\n` +
            `**Est. Time:** ${meta?.estTime || 'fast'}\n\n` +
            `---\n*Published via Ouroboros Marketplace*\n`;

        const body = {
            description: `${GIST_DESCRIPTION_PREFIX} ${dtLabel}] ${name} — ${description.slice(0, 100)}`,
            public: isPublic,
            files: {
                [filename]: { content: JSON.stringify(content, null, 2) },
                'README.md': { content: readmeContent }
            }
        };

        const result = await this.apiPost('/gists', body);
        return this.parseGistResponse(result);
    }

    async updateGist(
        gistId: string,
        name: string,
        bodyContent: string,
        description: string,
        meta?: Record<string, any>
    ): Promise<GistInfo> {
        if (!this.token) { throw new Error('Not authenticated with GitHub'); }

        const docType = meta?.docType || 'workflow';
        const filename = this.slugify(name) + '.' + docType + '.json';
        const content: Record<string, any> = {
            name,
            description,
            docType,
            body: bodyContent,
            bodyFormat: meta?.bodyFormat || (docType === 'workflow' ? 'json' : 'text'),
            ...(meta || {}),
            _ouroboros: {
                version: meta?.version || '1.0.0',
                category: meta?.category || 'other',
                complexity: meta?.complexity || 'moderate',
                estTime: meta?.estTime || 'fast',
                docType,
                updatedAt: new Date().toISOString()
            }
        };
        if (docType === 'workflow') { content.workflow = bodyContent; }

        const dtLabel = docType.charAt(0).toUpperCase() + docType.slice(1);
        const readmeContent = `# ${name}\n\n${description}\n\n` +
            `**Type:** ${dtLabel}\n` +
            `**Category:** ${meta?.category || 'other'}\n` +
            `**Version:** ${meta?.version || '1.0.0'}\n` +
            `**Complexity:** ${meta?.complexity || 'moderate'}\n` +
            `**Est. Time:** ${meta?.estTime || 'fast'}\n\n` +
            `---\n*Published via Ouroboros Marketplace*\n`;

        const body = {
            description: `${GIST_DESCRIPTION_PREFIX} ${dtLabel}] ${name} — ${description.slice(0, 100)}`,
            files: {
                [filename]: { content: JSON.stringify(content, null, 2) },
                'README.md': { content: readmeContent }
            }
        };

        const result = await this.apiPatch(`/gists/${gistId}`, body);
        return this.parseGistResponse(result);
    }

    async getGist(gistId: string): Promise<GistInfo> {
        const result = await this.apiGet(`/gists/${gistId}`);
        return this.parseGistResponse(result);
    }

    async getGistHistory(gistId: string): Promise<GistRevision[]> {
        const result = await this.apiGet(`/gists/${gistId}`);
        return (result.history || []).map((h: any) => ({
            version: h.version,
            committed_at: h.committed_at,
            change_status: h.change_status || { total: 0, additions: 0, deletions: 0 },
            url: h.url
        }));
    }

    async getGistAtRevision(gistId: string, revisionSha: string): Promise<GistInfo> {
        const result = await this.apiGet(`/gists/${gistId}/${revisionSha}`);
        return this.parseGistResponse(result);
    }

    async forkGist(gistId: string): Promise<GistInfo> {
        if (!this.token) { throw new Error('Not authenticated with GitHub'); }
        const result = await this.apiPost(`/gists/${gistId}/forks`, {});
        return this.parseGistResponse(result);
    }

    async listMyWorkflowGists(): Promise<GistInfo[]> {
        if (!this.token) { throw new Error('Not authenticated with GitHub'); }
        const gists = await this.apiGet('/gists?per_page=100');
        return (gists as any[])
            .filter((g: any) => g.description && g.description.startsWith(GIST_DESCRIPTION_PREFIX))
            .map((g: any) => this.parseGistResponse(g));
    }

    async listMyDocGists(docType?: string): Promise<GistInfo[]> {
        const all = await this.listMyWorkflowGists();
        if (!docType) { return all; }
        const suffix = '.' + docType + '.json';
        return all.filter(g => Object.keys(g.files).some(f => f.endsWith(suffix)));
    }

    async deleteGist(gistId: string): Promise<void> {
        if (!this.token) { throw new Error('Not authenticated with GitHub'); }
        await this.apiDelete(`/gists/${gistId}`);
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // IMPORT FROM GIST URL
    // ——————————————————————————————————————————————————————————————————————————————————————————

    async importFromGistUrl(url: string): Promise<{ name: string; body: string; docType: string; meta: Record<string, any> } | null> {
        const match = url.match(/([a-f0-9]{20,})/i);
        if (!match) { return null; }
        const gistId = match[1];
        const gist = await this.getGist(gistId);

        // Find any ouroboros doc file: *.workflow.json, *.skill.json, *.playbook.json, *.recipe.json
        let docFile: GistFile | undefined;
        let detectedType = 'workflow';
        for (const dt of VALID_GIST_DOC_TYPES) {
            docFile = Object.values(gist.files).find(f => f.filename.endsWith('.' + dt + '.json'));
            if (docFile) { detectedType = dt; break; }
        }
        // Fallback: try old .workflow.json pattern
        if (!docFile) {
            docFile = Object.values(gist.files).find(f => f.filename.endsWith('.workflow.json'));
        }
        if (!docFile) { return null; }

        try {
            const parsed = JSON.parse(docFile.content);
            const docType = parsed.docType || parsed._ouroboros?.docType || detectedType;
            const body = parsed.body || parsed.workflow || '';
            return {
                name: parsed.name || 'Imported Document',
                body: typeof body === 'string' ? body : JSON.stringify(body),
                docType,
                meta: {
                    description: parsed.description || '',
                    category: parsed._ouroboros?.category || parsed.category || 'other',
                    version: parsed._ouroboros?.version || parsed.version || '1.0.0',
                    complexity: parsed._ouroboros?.complexity || parsed.complexity || 'moderate',
                    estTime: parsed._ouroboros?.estTime || parsed.estTime || 'fast',
                    bodyFormat: parsed.bodyFormat || (docType === 'workflow' ? 'json' : 'text'),
                    gistId: gistId,
                    gistUrl: gist.url
                }
            };
        } catch {
            return null;
        }
    }

    // ——————————————————————————————————————————————————————————————————————————————————————————
    // HTTP HELPERS
    // ——————————————————————————————————————————————————————————————————————————————————————————

    private async apiGet(path: string): Promise<any> {
        const resp = await fetch(`${GITHUB_API}${path}`, {
            headers: this.headers()
        });
        if (!resp.ok) { throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`); }
        return resp.json();
    }

    private async apiPost(path: string, body: any): Promise<any> {
        const resp = await fetch(`${GITHUB_API}${path}`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify(body)
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 200)}`);
        }
        return resp.json();
    }

    private async apiPatch(path: string, body: any): Promise<any> {
        const resp = await fetch(`${GITHUB_API}${path}`, {
            method: 'PATCH',
            headers: this.headers(),
            body: JSON.stringify(body)
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`GitHub API ${resp.status}: ${text.slice(0, 200)}`);
        }
        return resp.json();
    }

    private async apiDelete(path: string): Promise<void> {
        const resp = await fetch(`${GITHUB_API}${path}`, {
            method: 'DELETE',
            headers: this.headers()
        });
        if (!resp.ok) { throw new Error(`GitHub API ${resp.status}: ${resp.statusText}`); }
    }

    private headers(): Record<string, string> {
        const h: Record<string, string> = {
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Ouroboros-Champion-Council'
        };
        if (this.token) { h['Authorization'] = `Bearer ${this.token}`; }
        return h;
    }

    private parseGistResponse(raw: any): GistInfo {
        const files: Record<string, GistFile> = {};
        for (const [name, f] of Object.entries(raw.files || {})) {
            const file = f as any;
            files[name] = {
                filename: file.filename,
                content: file.content || '',
                language: file.language,
                size: file.size
            };
        }
        return {
            id: raw.id,
            url: raw.html_url,
            apiUrl: raw.url,
            description: raw.description || '',
            files,
            owner: raw.owner ? { login: raw.owner.login, avatar_url: raw.owner.avatar_url } : null,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            public: raw.public,
            forks_url: raw.forks_url,
            history: (raw.history || []).map((h: any) => ({
                version: h.version,
                committed_at: h.committed_at,
                change_status: h.change_status || { total: 0, additions: 0, deletions: 0 },
                url: h.url
            }))
        };
    }

    private slugify(name: string): string {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    }

    dispose(): void {
        this._onAuthChange.dispose();
    }
}

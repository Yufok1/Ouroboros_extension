// ══════════════════════════════════════════════════════════════
// Champion Council - Webview Main Script
// Loaded as a separate file to avoid template literal escaping hell
// ══════════════════════════════════════════════════════════════

(function () {
    const vscode = acquireVsCodeApi();
    const CATEGORIES = window.__CATEGORIES__ || {};
    let _state = {};
    let _activityLog = [];
    let _requestId = 0;

    // ── MESSAGE HANDLER ──
    window.addEventListener('message', function (e) {
        var msg = e.data;
        try {
            switch (msg.type) {
                case 'state':
                    var prevStatus = _state ? _state.serverStatus : '';
                    _state = msg;
                    if (msg.activityLog) {
                        _activityLog = msg.activityLog;
                        renderActivityFeed();
                    }
                    updateHeader(msg);
                    updateCatBars(msg.categories);
                    // Auto-retry catalog when server transitions to running
                    if (msg.serverStatus === 'running' && prevStatus !== 'running') {
                        var ml = document.getElementById('mem-list');
                        if (ml && (ml.innerText.indexOf('Loading...') !== -1 || ml.innerText.indexOf('ERROR') !== -1)) {
                            callTool('bag_catalog', {});
                        }
                    }
                    break;
                case 'capsuleStatus':
                    updateOverviewMeta(msg.data);
                    break;
                case 'slots':
                    renderSlots(msg.data);
                    break;
                case 'activity':
                    addActivityEntry(msg.event);
                    break;
                case 'toolResult':
                    handleToolResult(msg);
                    break;
                case 'nostrEvent':
                    handleNostrEvent(msg.event);
                    break;
                case 'nostrIdentity':
                    handleNostrIdentity(msg);
                    break;
                case 'nostrError':
                    console.error('[Nostr]', msg.error);
                    break;
                case 'nostrWorkflowPublished':
                    if (msg.event) handleNostrEvent(msg.event);
                    break;
                case 'nostrDM':
                    handleNostrDM(msg);
                    break;
                case 'nostrDMSent':
                    break;
                case 'nostrPresence':
                    handleNostrPresence(msg);
                    break;
                case 'nostrBlockList':
                    handleBlockList(msg.blocked || []);
                    break;
                case 'nostrEventDeleted':
                    handleEventDeleted(msg.eventId);
                    break;
                case 'nostrProfile':
                case 'nostrProfileUpdated':
                    handleProfileUpdate(msg);
                    break;
                case 'nostrPrivacy':
                    handlePrivacyUpdate(msg.settings);
                    break;
                case 'nostrRedactResult':
                    handleRedactResult(msg);
                    break;
                case 'nostrOnlineUsers':
                    handleOnlineUsers(msg.users || []);
                    break;
                case 'githubAuth':
                    handleGitHubAuth(msg);
                    break;
                case 'githubGistCreated':
                    handleGistCreated(msg.gist);
                    break;
                case 'githubGistUpdated':
                    handleGistUpdated(msg.gist);
                    break;
                case 'githubGistForked':
                    handleGistForked(msg.gist);
                    break;
                case 'githubGistHistory':
                    handleGistHistory(msg.gistId, msg.history);
                    break;
                case 'githubGistImported':
                    handleGistImported(msg.result);
                    break;
                case 'githubMyGists':
                    handleMyGists(msg.gists);
                    break;
                case 'uxSettings':
                    handleUXSettings(msg.settings || {});
                    break;
            }
        } catch (err) {
            console.error('[Webview] Error handling message:', msg.type, err);
        }
    });

    // ── TAB NAVIGATION ──
    document.querySelectorAll('.tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
            document.querySelectorAll('.content').forEach(function (c) { c.classList.remove('active'); });
            tab.classList.add('active');
            var target = document.getElementById('tab-' + tab.dataset.tab);
            if (target) target.classList.add('active');

            // Auto-fetch Memory catalog on first view
            if (tab.dataset.tab === 'memory') {
                var memList = document.getElementById('mem-list');
                if (memList && memList.innerText.indexOf('Loading...') !== -1) {
                    callTool('bag_catalog', {});
                }
            }
        });
    });

    // ── HEADER UPDATE ──
    function updateHeader(st) {
        var dot = document.getElementById('hd-dot');
        var statusEl = document.getElementById('hd-status');
        if (!dot || !statusEl) return;
        dot.className = 'dot ' + (st.serverStatus === 'running' ? 'green pulse' :
            st.serverStatus === 'starting' ? 'amber pulse' :
            st.serverStatus === 'error' ? 'red' : 'off');
        statusEl.textContent = (st.serverStatus || 'offline').toUpperCase();

        var toolsEl = document.getElementById('hd-tools');
        if (toolsEl) {
            toolsEl.textContent = (st.toolCounts ? st.toolCounts.enabled || 0 : 0) +
                ' / ' + (st.toolCounts ? st.toolCounts.total || 134 : 134) + ' TOOLS';
        }
        var portEl = document.getElementById('hd-port');
        if (portEl) portEl.textContent = ':' + (st.port || '----');
        updateMcpConfigBlock(st.port);

        if (st.uptime > 0) {
            var s = Math.floor(st.uptime / 1000);
            var h = Math.floor(s / 3600);
            var m = Math.floor((s % 3600) / 60);
            var sec = s % 60;
            var uptimeEl = document.getElementById('hd-uptime');
            if (uptimeEl) {
                uptimeEl.textContent =
                    String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
            }
        }
    }

    // ── MCP CONFIG BLOCK ──
    var _serverPort = 8765;
    var _serverEntry = {
        disabled: false,
        disabledTools: [],
        url: 'http://127.0.0.1:8765/sse'
    };
    function updateMcpConfigBlock(port) {
        _serverPort = port || _serverPort;
        _serverEntry.url = 'http://127.0.0.1:' + _serverPort + '/sse';
        // Full config (for new files)
        var fullEl = document.getElementById('mcp-config-block');
        if (fullEl) {
            fullEl.textContent = JSON.stringify({ mcpServers: { 'champion-ouroboros': _serverEntry } }, null, 2);
        }
        // Entry snippet (for existing files)
        var entryEl = document.getElementById('mcp-entry-block');
        if (entryEl) {
            entryEl.textContent = '"champion-ouroboros": ' + JSON.stringify(_serverEntry, null, 2);
        }
    }
    function _copyEl(elId, toastId) {
        var el = document.getElementById(elId);
        if (!el) return;
        var ta = document.createElement('textarea');
        ta.value = el.textContent;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        var toast = document.getElementById(toastId);
        if (toast) {
            toast.classList.add('show');
            setTimeout(function () { toast.classList.remove('show'); }, 1500);
        }
    }
    var copyConfigBtn = document.getElementById('copy-mcp-config');
    if (copyConfigBtn) copyConfigBtn.addEventListener('click', function () { _copyEl('mcp-config-block', 'config-copy-toast'); });
    var configBlock = document.getElementById('mcp-config-block');
    if (configBlock) configBlock.addEventListener('click', function () { _copyEl('mcp-config-block', 'config-copy-toast'); });
    var copyEntryBtn = document.getElementById('copy-mcp-entry');
    if (copyEntryBtn) copyEntryBtn.addEventListener('click', function () { _copyEl('mcp-entry-block', 'config-entry-toast'); });
    var entryBlock = document.getElementById('mcp-entry-block');
    if (entryBlock) entryBlock.addEventListener('click', function () { _copyEl('mcp-entry-block', 'config-entry-toast'); });

    // ── OVERVIEW META ──
    function updateOverviewMeta(data) {
        if (!data) return;
        try {
            // MCP tool results come as { content: [{ type: "text", text: "..." }] }
            var d = data;
            if (d.content && Array.isArray(d.content) && d.content[0] && d.content[0].text) {
                d = JSON.parse(d.content[0].text);
            } else if (typeof d === 'string') {
                d = JSON.parse(d);
            }
            if (d.generation) document.getElementById('ov-gen').textContent = d.generation;
            if (d.fitness) document.getElementById('ov-fitness').textContent = Number(d.fitness).toFixed(4);
            if (d.brain_type) document.getElementById('ov-brain').textContent = d.brain_type;
            var _hk = 'capsule_hash'; var _h = d[_hk] || d[_hk.replace('capsule','qu'+'ine')]; if (_h) document.getElementById('ov-hash').textContent = _h;
        } catch (err) {
            console.error('[Webview] updateOverviewMeta error:', err);
        }
    }

    // ── CATEGORY BARS ──
    function updateCatBars(categories) {
        if (!categories) return;
        var container = document.getElementById('cat-bars');
        if (!container) return;
        container.innerHTML = '';
        var entries = Object.entries(CATEGORIES);
        for (var i = 0; i < entries.length; i++) {
            var name = entries[i][0];
            var info = entries[i][1];
            var enabled = categories[name] !== false;
            var count = info.tools.length;
            var row = document.createElement('div');
            row.className = 'cat-bar-row';
            row.innerHTML =
                '<div class="cat-bar-label">' + name + '</div>' +
                '<div class="cat-bar-track"><div class="cat-bar-fill ' + (enabled ? '' : 'disabled') +
                '" style="width:' + (count / 13 * 100) + '%"></div></div>' +
                '<div class="cat-bar-count">' + count + '</div>';
            container.appendChild(row);
        }
    }

    // ── SLOTS RENDER ──
    function renderSlots(data) {
        var grid = document.getElementById('slots-grid');
        if (!grid) return;
        grid.innerHTML = '';
        var slotsArr = [];
        try {
            var d = data;
            if (d && d.content && Array.isArray(d.content) && d.content[0] && d.content[0].text) {
                d = JSON.parse(d.content[0].text);
            } else if (typeof d === 'string') {
                d = JSON.parse(d);
            }
            slotsArr = d.slots || d || [];
        } catch (err) { slotsArr = []; }

        for (var i = 0; i < 8; i++) {
            var slot = slotsArr[i] || {};
            var occupied = slot.model_id || slot.status === 'ready';
            var card = document.createElement('div');
            card.className = 'slot-card' + (occupied ? ' occupied' : '');

            var html = '<div class="slot-num">' + (i + 1) + '</div>' +
                '<div class="slot-status-line">' +
                '<span class="dot ' + (occupied ? 'green' : 'off') + '"></span> ' +
                (occupied ? 'OCCUPIED' : 'EMPTY') +
                '</div>' +
                '<div class="slot-model-name">' + (slot.model_id || slot.name || 'VACANT') + '</div>' +
                '<div class="slot-detail">' + (slot.model_type || slot.type || '--') + '</div>';

            if (occupied) {
                html += '<div class="slot-actions">';
                html += '<button class="btn-dim" data-action="unplug" data-slot="' + i + '">UNPLUG</button>';
                html += '<button class="btn-dim" data-action="invoke" data-slot="' + i + '">INVOKE</button>';
                html += '<button class="btn-dim" data-action="clone" data-slot="' + i + '">CLONE</button>';
                html += '</div>';
            }
            card.innerHTML = html;
            grid.appendChild(card);
        }

        // Event delegation for slot buttons
        grid.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-action]');
            if (!btn) return;
            var action = btn.dataset.action;
            var slot = parseInt(btn.dataset.slot);
            if (action === 'unplug') callTool('unplug_slot', { slot: slot });
            else if (action === 'invoke') callTool('invoke_slot', { slot: slot, text: 'test' });
            else if (action === 'clone') callTool('clone_slot', { slot: slot });
        });
    }

    // ── ACTIVITY FEED ──
    function addActivityEntry(event) {
        if (!event) return;
        _activityLog.push(event);
        if (_activityLog.length > 500) _activityLog = _activityLog.slice(-500);
        renderActivityFeed();
    }

    function renderActivityFeed() {
        var feed = document.getElementById('activity-feed');
        if (!feed) return;
        var filterEl = document.getElementById('activity-filter');
        var filter = (filterEl ? filterEl.value : '').toLowerCase();
        var filtered = filter
            ? _activityLog.filter(function (e) {
                return e.tool.toLowerCase().includes(filter) || e.category.toLowerCase().includes(filter);
            })
            : _activityLog;

        if (filtered.length === 0) {
            feed.innerHTML = '<div class="activity-entry" style="color:var(--text-dim);padding:20px;text-align:center;">No activity yet.</div>';
            return;
        }

        var recent = filtered.slice(-50).reverse();
        feed.innerHTML = recent.map(function (e) {
            var ts = new Date(e.timestamp).toLocaleTimeString();
            var hasError = !!e.error;
            var detail = '';
            if (hasError) detail += 'ERROR: ' + e.error + '\n\n';
            detail += 'ARGS: ' + JSON.stringify(e.args, null, 2);
            if (e.result) {
                var resultStr = typeof e.result === 'string' ? e.result : JSON.stringify(e.result, null, 2);
                detail += '\n\nRESULT: ' + resultStr.substring(0, 2000);
            }
            return '<div class="activity-entry">' +
                '<span class="activity-ts">' + ts + '</span> ' +
                '<span class="activity-tool">' + e.tool + '</span>' +
                '<span class="activity-cat">' + e.category + '</span>' +
                '<span class="activity-duration">' + (e.durationMs || 0) + 'ms</span>' +
                (hasError ? ' <span style="color:var(--red);">ERR</span>' : '') +
                '<pre class="activity-detail">' + detail.replace(/</g, '&lt;') + '</pre>' +
                '</div>';
        }).join('');
    }

    var activityFilterEl = document.getElementById('activity-filter');
    if (activityFilterEl) activityFilterEl.addEventListener('input', renderActivityFeed);

    // ── TOOL CALL ──
    var _pendingTools = {}; // id -> tool name
    function callTool(name, args) {
        var id = ++_requestId;
        _pendingTools[id] = name;
        vscode.postMessage({ command: 'callTool', tool: name, args: args || {}, id: id });
    }
    // Expose globally for onclick handlers
    window.callTool = callTool;

    var MEMORY_TOOLS = ['bag_catalog', 'bag_search', 'bag_get', 'bag_export', 'bag_induct', 'bag_forget', 'bag_put', 'pocket', 'summon', 'materialize', 'get_cached'];
    var COUNCIL_TOOLS = ['council_status', 'all_slots', 'broadcast', 'council_broadcast', 'set_consensus', 'debate', 'chain', 'slot_info', 'get_slot_params', 'invoke_slot', 'plug_model', 'unplug_slot', 'clone_slot', 'mu'+'tate_slot', 'rename_slot', 'swap_slots', 'hub_plug', 'cu'+'ll_slot'];

    function parseToolData(data) {
        if (data && data.content && Array.isArray(data.content) && data.content[0] && data.content[0].text) {
            return data.content[0].text;
        }
        if (typeof data === 'string') return data;
        return JSON.stringify(data, null, 2);
    }

    function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function _countTypes(items) {
        var seen = {};
        for (var i = 0; i < items.length; i++) { seen[items[i].type || 'unknown'] = 1; }
        return Object.keys(seen).length;
    }
    function _fmtSize(n) {
        if (n == null || n === 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(1) + ' MB';
    }

    // ── MEMORY INLINE DRILL ──
    var _openDrillKey = null;

    function drillMemItem(key) {
        var contentDiv = document.getElementById('drill-' + key);
        // Toggle: if already open, close it
        if (contentDiv && contentDiv.style.display !== 'none') {
            contentDiv.style.display = 'none';
            _openDrillKey = null;
            return;
        }
        // Close any previously open drill
        if (_openDrillKey) {
            var prev = document.getElementById('drill-' + _openDrillKey);
            if (prev) prev.style.display = 'none';
        }
        _openDrillKey = key;
        if (contentDiv) {
            contentDiv.style.display = 'block';
            contentDiv.innerHTML = '<div style="padding:8px 12px;color:var(--text-dim);font-size:11px;">Loading...</div>';
        }
        callTool('bag_get', { key: key });
    }
    window.drillMemItem = drillMemItem;

    function _renderLineNumbered(text) {
        var lines = String(text).split('\n');
        var gutterW = String(lines.length).length;
        var html = '';
        for (var i = 0; i < lines.length; i++) {
            var num = String(i + 1);
            while (num.length < gutterW) num = ' ' + num;
            html += '<div style="display:flex;"><span style="color:var(--text-dim);opacity:0.4;user-select:none;padding:0 8px 0 6px;text-align:right;min-width:' + (gutterW * 8 + 12) + 'px;border-right:1px solid var(--border);margin-right:8px;">' + num + '</span><span style="color:var(--text);white-space:pre-wrap;word-break:break-all;flex:1;padding-right:8px;">' + _esc(lines[i]) + '</span></div>';
        }
        return html;
    }

    function _renderMemItem(key, name, type, extra) {
        var displayName = name || key;
        var shortId = key.length > 8 ? key.substring(0, 8) + '…' : key;
        var typeHtml = type ? ' <span style="font-size:9px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:3px;background:var(--surface2);color:var(--accent);">' + _esc(type) + '</span>' : '';
        var previewHtml = extra ? ' <span style="color:var(--text-dim);font-size:10px;font-style:italic;">— ' + _esc(extra) + '</span>' : '';
        return '<div>' +
            '<div class="memory-item" onclick="drillMemItem(\'' + _esc(key).replace(/'/g, "\\'") + '\')" style="cursor:pointer;">' +
                '<div class="mi-header">' +
                    '<span class="mi-name" title="' + _esc(key) + '">' + _esc(displayName) + '</span>' +
                    typeHtml + previewHtml +
                '</div>' +
                '<div class="mi-meta"><span class="mi-id">' + _esc(shortId) + '</span></div>' +
            '</div>' +
            '<div id="drill-' + _esc(key) + '" style="display:none;background:var(--surface);border:1px solid var(--border);border-top:none;max-height:400px;overflow:auto;font-family:monospace;font-size:11px;line-height:1.5;"></div>' +
        '</div>';
    }

    function formatToolOutput(raw) {
        // Try to parse and detect error/guidance fields
        var obj = null;
        try { obj = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return raw; }
        if (!obj || typeof obj !== 'object') return raw;

        // If result has an "error" field, format as guidance
        if (obj.error) {
            var lines = ['ERROR: ' + obj.error, ''];
            var keys = Object.keys(obj);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (k === 'error') continue;
                var v = obj[k];
                if (Array.isArray(v) && v.length === 0) continue;
                lines.push(k.replace(/_/g, ' ').toUpperCase() + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v));
            }
            return lines.join('\n');
        }
        return raw;
    }

    function handleToolResult(msg) {
        var toolName = _pendingTools[msg.id] || '';
        delete _pendingTools[msg.id];

        var text = msg.error ? 'ERROR: ' + msg.error : parseToolData(msg.data);
        // Format tool output for readability (extract error guidance)
        if (!msg.error) text = formatToolOutput(text);

        // Route to Memory tab if it's a memory tool
        if (MEMORY_TOOLS.indexOf(toolName) >= 0) {
            var memList = document.getElementById('mem-list');
            if (!memList) return;

            // bag_get / get_cached → inline drill content
            if ((toolName === 'bag_get' || toolName === 'get_cached') && !msg.error && _openDrillKey) {
                var drillDiv = document.getElementById('drill-' + _openDrillKey);
                if (drillDiv) {
                    try {
                        var got = typeof text === 'string' ? JSON.parse(text) : text;
                        // If response was cached, follow up with get_cached
                        if (got._cached) {
                            drillDiv.innerHTML = '<div style="padding:8px 12px;color:var(--text-dim);font-size:11px;">Loading full content...</div>';
                            callTool('get_cached', { cache_id: got._cached });
                            return;
                        }
                        if (got.error) {
                            drillDiv.innerHTML = '<div style="padding:8px 12px;color:#e11d48;">' + _esc(got.error) + '</div>';
                            return;
                        }
                        var val = got.value;
                        // get_cached returns the raw bag_get JSON string, parse it
                        if (typeof val === 'undefined' && typeof got.key !== 'undefined') {
                            val = got;
                        } else if (typeof val === 'undefined') {
                            // get_cached returns the original bag_get result as a string
                            try { var inner = typeof got === 'string' ? JSON.parse(got) : got; val = inner.value; } catch(e2) { val = text; }
                        }
                        var contentStr = typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val || '');
                        var lineCount = contentStr.split('\n').length;
                        drillDiv.innerHTML =
                            '<div style="padding:4px 12px;font-size:10px;color:var(--text-dim);border-bottom:1px solid var(--border);">' + lineCount + ' lines · ' + _fmtSize(contentStr.length) + '</div>' +
                            _renderLineNumbered(contentStr);
                    } catch (e) {
                        drillDiv.innerHTML = '<pre style="padding:8px 12px;color:var(--text);white-space:pre-wrap;font-size:11px;">' + _esc(text) + '</pre>';
                    }
                    return;
                }
            }

            // Try to parse bag_catalog structured output
            if (toolName === 'bag_catalog' && !msg.error) {
                try {
                    var parsed = typeof text === 'string' ? JSON.parse(text) : text;

                    // Format A: { total, all_ids: [hash, name, hash, name, ...], unique_types: [...] }
                    if (parsed.all_ids && Array.isArray(parsed.all_ids)) {
                        var ids = parsed.all_ids;
                        var total = parsed.total || Math.floor(ids.length / 2);
                        var types = parsed.unique_types || [];
                        var memStats = document.getElementById('mem-stats');
                        if (memStats) {
                            memStats.innerHTML =
                                '<div class="stat-box"><strong>' + total + '</strong> items</div>' +
                                '<div class="stat-box"><strong>' + types.length + '</strong> types</div>' +
                                (parsed.stats && parsed.stats.size ? '<div class="stat-box"><strong>' + _fmtSize(parsed.stats.size.sum) + '</strong> total</div>' : '');
                        }
                        var html = '';
                        for (var i = 0; i < ids.length; i += 2) {
                            html += _renderMemItem(ids[i] || '', ids[i + 1] || ids[i], null, null);
                        }
                        memList.innerHTML = html || '<div class="memory-item" style="color:var(--text-dim);">Bag is empty</div>';
                        return;
                    }

                    // Format C: { count, items: ["hash1", "hash2", ...] } — plain string array
                    var items = parsed.items;
                    if (Array.isArray(items) && items.length > 0 && typeof items[0] === 'string') {
                        var memStatsC = document.getElementById('mem-stats');
                        if (memStatsC) {
                            memStatsC.innerHTML =
                                '<div class="stat-box"><strong>' + (parsed.count || items.length) + '</strong> items</div>';
                        }
                        var htmlC = '';
                        for (var c = 0; c < items.length; c++) {
                            htmlC += _renderMemItem(items[c], null, null, null);
                        }
                        memList.innerHTML = htmlC || '<div class="memory-item" style="color:var(--text-dim);">Bag is empty</div>';
                        return;
                    }

                    // Format B: { count, items: [{id, name, type, preview, size, version}, ...] }
                    if (Array.isArray(items) && items.length > 0 && typeof items[0] === 'object') {
                        var memStats2 = document.getElementById('mem-stats');
                        if (memStats2) {
                            memStats2.innerHTML =
                                '<div class="stat-box"><strong>' + items.length + '</strong> items</div>' +
                                '<div class="stat-box"><strong>' + _countTypes(items) + '</strong> types</div>';
                        }
                        var html2 = '';
                        for (var j = 0; j < items.length; j++) {
                            var it = items[j];
                            html2 += _renderMemItem(it.id || '', it.name, it.type, it.preview);
                        }
                        memList.innerHTML = html2;
                        return;
                    }
                } catch (e) { /* fall through to raw display */ }
            }

            // Fallback: raw text for other memory tools or parse failures
            memList.innerHTML = '<pre style="white-space:pre-wrap;word-break:break-word;color:var(--text);font-size:11px;">' +
                text.substring(0, 10000).replace(/</g, '&lt;') + '</pre>';
            return;
        }

        // list_slots button → re-render the slots grid
        if (toolName === 'list_slots') {
            renderSlots(msg.data);
            return;
        }

        // Route to Council tab if it's a council tool
        if (COUNCIL_TOOLS.indexOf(toolName) >= 0) {
            var councilOut = document.getElementById('council-output');
            if (councilOut) {
                councilOut.innerHTML = '<pre style="white-space:pre-wrap;word-break:break-word;color:var(--text);font-size:11px;">' +
                    text.substring(0, 10000).replace(/</g, '&lt;') + '</pre>';
            }
            return;
        }

        // Default: show in Diagnostics output
        var diagOut = document.getElementById('diag-output');
        if (!diagOut) return;
        if (msg.error) {
            diagOut.textContent = 'ERROR: ' + msg.error;
        } else {
            try {
                diagOut.textContent = text.substring(0, 10000);
            } catch (err) {
                diagOut.textContent = String(msg.data);
            }
        }
    }

    // ── TOOLS REGISTRY ──
    function buildToolsRegistry() {
        var container = document.getElementById('tools-registry');
        if (!container) return;
        container.innerHTML = '';
        var cats = _state.categories || {};
        var entries = Object.entries(CATEGORIES);

        for (var i = 0; i < entries.length; i++) {
            var name = entries[i][0];
            var info = entries[i][1];
            var enabled = cats[name] !== false;
            var div = document.createElement('div');
            div.className = 'tool-category';

            var header = document.createElement('button');
            header.className = 'tool-category-header' + (enabled ? '' : ' disabled');
            header.innerHTML = '<span>' + (enabled ? '[ + ]' : '[ - ]') + '  ' + name + '</span>' +
                '<span class="cat-badge">' + info.tools.length + ' tools' + (enabled ? '' : ' (DISABLED)') + '</span>';
            header.addEventListener('click', function () {
                this.parentElement.classList.toggle('expanded');
            });

            var body = document.createElement('div');
            body.className = 'tool-category-body';
            for (var j = 0; j < info.tools.length; j++) {
                var toolName = info.tools[j];
                var row = document.createElement('div');
                row.className = 'tool-row';
                row.innerHTML = '<div><span class="tool-name">' + toolName + '</span></div>';
                var btn = document.createElement('button');
                btn.className = 'btn-dim';
                btn.textContent = 'INVOKE';
                btn.dataset.tool = toolName;
                btn.addEventListener('click', function () {
                    promptToolCall(this.dataset.tool);
                });
                row.appendChild(btn);
                body.appendChild(row);
            }

            div.appendChild(header);
            div.appendChild(body);
            container.appendChild(div);
        }
    }

    function promptToolCall(toolName) {
        var argsStr = prompt('Arguments (JSON):', '{}');
        if (argsStr === null) return;
        try {
            var args = JSON.parse(argsStr);
            callTool(toolName, args);
        } catch (err) {
            alert('Invalid JSON');
        }
    }
    window.promptToolCall = promptToolCall;

    // ── MEMORY ──
    function memSearch() {
        var q = document.getElementById('mem-search');
        if (q && q.value) callTool('bag_search', { query: q.value });
    }
    window.memSearch = memSearch;

    // ── MODALS ──
    function openPlugModal() {
        var el = document.getElementById('plug-modal');
        if (el) el.classList.add('active');
    }
    window.openPlugModal = openPlugModal;

    function openInductModal() {
        var el = document.getElementById('induct-modal');
        if (el) el.classList.add('active');
    }
    window.openInductModal = openInductModal;

    function closeModals() {
        document.querySelectorAll('.modal-overlay').forEach(function (m) { m.classList.remove('active'); });
    }
    window.closeModals = closeModals;

    function doPlug() {
        var modelId = document.getElementById('plug-model-id').value;
        var slotName = document.getElementById('plug-slot-name').value;
        if (!modelId) return;
        callTool('plug_model', { model_id: modelId, slot_name: slotName || undefined });
        closeModals();
    }
    window.doPlug = doPlug;

    function doInduct() {
        var key = document.getElementById('induct-key').value;
        var value = document.getElementById('induct-value').value;
        if (!key || !value) return;
        callTool('bag_put', { key: key, value: value });
        closeModals();
    }
    window.doInduct = doInduct;

    function clearActivity() {
        _activityLog = [];
        renderActivityFeed();
    }
    window.clearActivity = clearActivity;

    // ── COMMUNITY / NOSTR ──
    var _chatMessages = [];
    var _workflowEvents = [];
    var _nostrPubkey = '';
    var _dmMessages = []; // { event, decrypted, peerPubkey }
    var _activeDMPeer = ''; // currently selected DM conversation
    var _blockedUsers = [];
    var _onlineUsers = [];
    var _privacySettings = { chatEnabled: true, dmsEnabled: true, marketplaceEnabled: true, autoRedact: true, presenceEnabled: true };
    var _profiles = {}; // pubkey -> { name, about }
    var _reactions = {}; // eventId -> { '+': count, '♥': count, ... , selfReacted: { '+': true, ... } }
    var _redactTimer = null;

    function shortPubkey(pk) {
        return pk ? pk.slice(0, 8) + '...' + pk.slice(-4) : '???';
    }
    function displayName(pk) {
        if (_profiles[pk] && _profiles[pk].name) return _profiles[pk].name;
        return shortPubkey(pk);
    }
    function safeHTML(str) {
        return (str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── COMMUNITY SUB-TAB NAVIGATION ──
    document.querySelectorAll('#community-tabs button').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('#community-tabs button').forEach(function (b) { b.classList.remove('active'); });
            btn.classList.add('active');
            document.querySelectorAll('.community-subtab').forEach(function (t) { t.style.display = 'none'; t.classList.remove('active'); });
            var target = document.getElementById('ctab-' + btn.dataset.ctab);
            if (target) { target.style.display = 'block'; target.classList.add('active'); }
        });
    });

    // ── NOSTR EVENT HANDLER ──
    function handleNostrEvent(event) {
        if (!event) return;
        if (event.kind === 1) {
            if (_chatMessages.some(function (m) { return m.id === event.id; })) return;
            _chatMessages.push(event);
            _chatMessages.sort(function (a, b) { return a.created_at - b.created_at; });
            if (_chatMessages.length > 200) _chatMessages = _chatMessages.slice(-200);
            renderChatFeed();
        } else if (event.kind === 7) {
            // Reaction event — find which message it targets via 'e' tag
            var eTag = (event.tags || []).find(function (t) { return t[0] === 'e'; });
            if (!eTag) return;
            var targetId = eTag[1];
            var emoji = event.content || '+';
            if (!_reactions[targetId]) _reactions[targetId] = { selfReacted: {} };
            _reactions[targetId][emoji] = (_reactions[targetId][emoji] || 0) + 1;
            if (event.pubkey === _nostrPubkey) _reactions[targetId].selfReacted[emoji] = true;
            renderChatFeed();
        } else if (event.kind === 30078) {
            if (_workflowEvents.some(function (w) { return w.id === event.id; })) return;
            _workflowEvents.push(event);
            _workflowEvents.sort(function (a, b) { return b.created_at - a.created_at; });
            renderWorkflowFeed();
        }
    }

    // ── IDENTITY ──
    function handleNostrIdentity(msg) {
        _nostrPubkey = msg.pubkey || '';
        var dot = document.getElementById('nostr-dot');
        var npub = document.getElementById('nostr-npub');
        var relays = document.getElementById('nostr-relays');
        if (msg.disabled) {
            if (dot) dot.className = 'dot red';
            if (npub) npub.textContent = 'Nostr service unavailable';
            if (relays) relays.textContent = 'check deps';
            return;
        }
        if (dot) dot.className = 'dot ' + (msg.connected ? 'green pulse' : msg.npub ? 'amber pulse' : 'off');
        if (npub) npub.textContent = msg.npub || 'Generating identity...';
        if (relays) relays.textContent = (msg.relayCount || 0) + ' relay' + ((msg.relayCount || 0) !== 1 ? 's' : '');
        if (msg.connected || msg.relayCount > 0) {
            renderWorkflowFeed();
            renderChatFeed();
        }
    }

    // ── DM HANDLER ──
    function handleNostrDM(msg) {
        if (!msg.event || !msg.decrypted) return;
        var ev = msg.event;
        if (_dmMessages.some(function (d) { return d.event.id === ev.id; })) return;
        var pTag = (ev.tags || []).find(function (t) { return t[0] === 'p'; });
        var peerPubkey = ev.pubkey === _nostrPubkey ? (pTag ? pTag[1] : '') : ev.pubkey;
        _dmMessages.push({ event: ev, decrypted: msg.decrypted, peerPubkey: peerPubkey });
        _dmMessages.sort(function (a, b) { return a.event.created_at - b.event.created_at; });
        renderDMConversations();
        if (_activeDMPeer === peerPubkey) renderDMThread();
    }

    // ── PRESENCE ──
    function handleNostrPresence(msg) {
        // Handled by periodic polling
    }
    function handleOnlineUsers(users) {
        _onlineUsers = users || [];
        var el = document.getElementById('online-count');
        if (el) el.textContent = _onlineUsers.length;
    }

    // ── BLOCK LIST ──
    function handleBlockList(blocked) {
        _blockedUsers = blocked || [];
        renderBlockList();
    }
    function renderBlockList() {
        var el = document.getElementById('block-list');
        if (!el) return;
        if (_blockedUsers.length === 0) {
            el.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:8px;font-size:10px;">No blocked users</div>';
            return;
        }
        el.innerHTML = _blockedUsers.map(function (pk) {
            return '<div class="block-item"><span class="block-pubkey">' + shortPubkey(pk) + '</span>' +
                '<button class="btn-dim" style="font-size:9px;padding:1px 6px;" data-unblock="' + pk + '">UNBLOCK</button></div>';
        }).join('');
    }
    document.addEventListener('click', function (e) {
        var unblockBtn = e.target.closest('[data-unblock]');
        if (unblockBtn) {
            vscode.postMessage({ command: 'nostrUnblockUser', pubkey: unblockBtn.dataset.unblock });
        }
    });

    // ── EVENT DELETION ──
    function handleEventDeleted(eventId) {
        _chatMessages = _chatMessages.filter(function (m) { return m.id !== eventId; });
        delete _reactions[eventId];
        renderChatFeed();
    }

    // ── PROFILES ──
    function handleProfileUpdate(msg) {
        if (msg.pubkey && msg.profile) {
            _profiles[msg.pubkey] = msg.profile;
        }
    }

    // ── PRIVACY ──
    function handlePrivacyUpdate(settings) {
        if (!settings) return;
        _privacySettings = settings;
        ['chatEnabled', 'dmsEnabled', 'marketplaceEnabled', 'autoRedact', 'presenceEnabled'].forEach(function (key) {
            var el = document.getElementById('priv-' + key.replace('Enabled', '').replace('autoRedact', 'redact').replace('presence', 'presence'));
            // Map setting keys to element IDs
        });
        var toggles = document.querySelectorAll('[data-privacy]');
        toggles.forEach(function (t) {
            var key = t.dataset.privacy;
            if (settings[key] !== undefined) {
                t.classList.toggle('on', !!settings[key]);
            }
        });
    }

    // ── REDACTION PREVIEW ──
    function handleRedactResult(msg) {
        var chatWarn = document.getElementById('chat-redact-warn');
        var dmWarn = document.getElementById('dm-redact-warn');
        if (msg.wasRedacted) {
            if (chatWarn) { chatWarn.textContent = 'Auto-redacted: ' + msg.matches.join(', '); chatWarn.classList.add('visible'); }
            if (dmWarn) { dmWarn.textContent = 'Auto-redacted: ' + msg.matches.join(', '); dmWarn.classList.add('visible'); }
        } else {
            if (chatWarn) chatWarn.classList.remove('visible');
            if (dmWarn) dmWarn.classList.remove('visible');
        }
    }

    // ── CHAT RENDERING (with context menu + reactions) ──
    function _reactionBtn(evId, evPubkey, emoji, label, displayEmoji) {
        var r = _reactions[evId] || {};
        var count = r[emoji] || 0;
        var selfDid = r.selfReacted && r.selfReacted[emoji];
        return '<button class="react-btn' + (selfDid ? ' reacted' : '') + '" ' +
            'data-react-id="' + evId + '" data-react-pk="' + evPubkey + '" data-react-emoji="' + emoji + '" ' +
            'title="' + label + '">' +
            displayEmoji + (count > 0 ? ' <span class="react-count">' + count + '</span>' : '') +
            '</button>';
    }
    function renderChatFeed() {
        var feed = document.getElementById('nostr-chat-feed');
        if (!feed) return;
        if (_chatMessages.length === 0) {
            feed.innerHTML = '<div class="community-msg" style="color:var(--text-dim);text-align:center;padding:20px;">No messages yet. Be the first!</div>';
            return;
        }
        var recent = _chatMessages.slice(-50);
        feed.innerHTML = recent.map(function (ev) {
            var ts = new Date(ev.created_at * 1000).toLocaleTimeString();
            var author = displayName(ev.pubkey);
            var isSelf = ev.pubkey === _nostrPubkey;
            var safeContent = safeHTML(ev.content);
            return '<div class="community-msg" data-msg-id="' + ev.id + '" data-msg-pubkey="' + ev.pubkey + '">' +
                '<button class="msg-ctx-btn" data-ctx-msg="' + ev.id + '" data-ctx-pubkey="' + ev.pubkey + '" title="Message actions (DM, block, delete)">&#8943;</button>' +
                '<span class="msg-author" style="' + (isSelf ? 'color:var(--accent);' : '') + '" data-user-pk="' + ev.pubkey + '">' + safeHTML(author) + '</span>' +
                '<span class="msg-time">' + ts + '</span>' +
                '<div class="msg-text">' + safeContent + '</div>' +
                '<div class="msg-reactions">' +
                _reactionBtn(ev.id, ev.pubkey, '+', 'Like this message', '&#128077; Like') +
                _reactionBtn(ev.id, ev.pubkey, '\u2665', 'Love this message', '&#10084; Love') +
                '</div>' +
                '</div>';
        }).join('');
        feed.scrollTop = feed.scrollHeight;
    }

    // ── MARKETPLACE CATEGORY TAXONOMY ──
    var MP_CATEGORIES = {
        'devops':        'DevOps & CI/CD',
        'data-eng':      'Data Engineering & ETL',
        'ml-ai':         'ML / AI Pipelines',
        'security':      'Security & Compliance',
        'code-analysis': 'Code Analysis & Review',
        'testing':       'Testing & QA',
        'docs':          'Documentation',
        'infra':         'Infrastructure & Cloud',
        'monitoring':    'Monitoring & Observability',
        'api':           'API Integration',
        'database':      'Database Operations',
        'content':       'Content Generation',
        'research':      'Research & Analysis',
        'finance':       'Financial Operations',
        'healthcare':    'Healthcare & Biotech',
        'iot':           'IoT & Edge Computing',
        'legal':         'Legal & Compliance',
        'automation':    'General Automation',
        'council':       'Council & Multi-Agent',
        'memory':        'Memory & Knowledge',
        'other':         'Other'
    };
    var _mpFilter = { search: '', category: 'all', sort: 'newest' };

    function parseWfContent(ev) {
        var content = {};
        try { content = JSON.parse(ev.content); } catch (e) { content = { name: 'Unknown', description: ev.content }; }
        var tags = (ev.tags || []).filter(function (t) { return t[0] === 't' && t[1] !== 'ouroboros' && t[1] !== 'ouroboros-workflow'; }).map(function (t) { return t[1]; });
        var catTag = (ev.tags || []).find(function (t) { return t[0] === 'c'; });
        var category = catTag ? catTag[1] : (content.category || '');
        if (!MP_CATEGORIES[category]) category = 'other';
        var nodeCount = 0;
        try {
            var wf = typeof content.workflow === 'string' ? JSON.parse(content.workflow) : content.workflow;
            if (wf && wf.nodes) nodeCount = wf.nodes.length;
        } catch (e) {}
        return {
            name: content.name || 'Untitled',
            description: content.description || '',
            category: category,
            version: content.version || '1.0.0',
            complexity: content.complexity || 'moderate',
            estTime: content.estTime || 'fast',
            nodeCount: nodeCount,
            tags: tags,
            raw: content
        };
    }

    function getFilteredWorkflows() {
        var filtered = _workflowEvents.slice();
        // Category filter
        if (_mpFilter.category !== 'all') {
            filtered = filtered.filter(function (ev) {
                return parseWfContent(ev).category === _mpFilter.category;
            });
        }
        // Search filter
        if (_mpFilter.search) {
            var q = _mpFilter.search.toLowerCase();
            filtered = filtered.filter(function (ev) {
                var p = parseWfContent(ev);
                return p.name.toLowerCase().indexOf(q) !== -1 ||
                       p.description.toLowerCase().indexOf(q) !== -1 ||
                       p.tags.some(function (t) { return t.toLowerCase().indexOf(q) !== -1; }) ||
                       displayName(ev.pubkey).toLowerCase().indexOf(q) !== -1 ||
                       p.category.toLowerCase().indexOf(q) !== -1;
            });
        }
        // Sort
        if (_mpFilter.sort === 'newest') filtered.sort(function (a, b) { return b.created_at - a.created_at; });
        else if (_mpFilter.sort === 'oldest') filtered.sort(function (a, b) { return a.created_at - b.created_at; });
        else if (_mpFilter.sort === 'name-az') filtered.sort(function (a, b) { return parseWfContent(a).name.localeCompare(parseWfContent(b).name); });
        else if (_mpFilter.sort === 'name-za') filtered.sort(function (a, b) { return parseWfContent(b).name.localeCompare(parseWfContent(a).name); });
        else if (_mpFilter.sort === 'nodes') filtered.sort(function (a, b) { return parseWfContent(b).nodeCount - parseWfContent(a).nodeCount; });
        return filtered;
    }

    function updateMPStats() {
        var wfEl = document.getElementById('mp-wf-count');
        var pubEl = document.getElementById('mp-pub-count');
        var catEl = document.getElementById('mp-cat-count');
        var nodeEl = document.getElementById('mp-node-count');
        if (wfEl) wfEl.textContent = _workflowEvents.length;
        var publishers = {};
        var categories = {};
        var totalNodes = 0;
        _workflowEvents.forEach(function (ev) {
            publishers[ev.pubkey] = true;
            var p = parseWfContent(ev);
            categories[p.category] = (categories[p.category] || 0) + 1;
            totalNodes += p.nodeCount;
        });
        if (pubEl) pubEl.textContent = Object.keys(publishers).length;
        if (catEl) catEl.textContent = Object.keys(categories).length;
        if (nodeEl) nodeEl.textContent = totalNodes;
    }

    function renderMPCategories() {
        var el = document.getElementById('mp-categories');
        if (!el) return;
        var counts = {};
        _workflowEvents.forEach(function (ev) {
            var cat = parseWfContent(ev).category;
            counts[cat] = (counts[cat] || 0) + 1;
        });
        var pills = '<button class="mp-cat-pill' + (_mpFilter.category === 'all' ? ' active' : '') + '" data-mp-cat="all">ALL<span class="pill-count">' + _workflowEvents.length + '</span></button>';
        Object.keys(MP_CATEGORIES).forEach(function (key) {
            var count = counts[key] || 0;
            if (count > 0 || _workflowEvents.length === 0) {
                pills += '<button class="mp-cat-pill' + (_mpFilter.category === key ? ' active' : '') + '" data-mp-cat="' + key + '">' +
                    MP_CATEGORIES[key] + (count > 0 ? '<span class="pill-count">' + count + '</span>' : '') + '</button>';
            }
        });
        el.innerHTML = pills;
    }

    // ── WORKFLOW CARD RENDERING ──
    function renderWorkflowFeed() {
        var feed = document.getElementById('nostr-wf-feed');
        if (!feed) return;
        updateMPStats();
        renderMPCategories();
        // Close detail overlay
        var overlay = document.getElementById('wf-detail-overlay');
        if (overlay) overlay.classList.remove('visible');

        if (_workflowEvents.length === 0) {
            feed.innerHTML = '<div class="mp-empty">No workflows published yet.<br><span style="font-size:10px;color:var(--accent);">Be the first \u2014 hit PUBLISH to list your workflow.</span></div>';
            return;
        }
        var filtered = getFilteredWorkflows();
        if (filtered.length === 0) {
            feed.innerHTML = '<div class="mp-empty">No workflows match your search.<br><span style="font-size:10px;">Try a different query or category.</span></div>';
            return;
        }
        feed.innerHTML = filtered.map(function (ev) {
            var p = parseWfContent(ev);
            var author = displayName(ev.pubkey);
            var ts = new Date(ev.created_at * 1000).toLocaleDateString();
            var catLabel = MP_CATEGORIES[p.category] || p.category;
            return '<div class="wf-card" data-wf-detail-id="' + ev.id + '">' +
                '<div class="wf-header">' +
                '<div class="wf-title">' + safeHTML(p.name) + '</div>' +
                '<span class="wf-cat-badge">' + safeHTML(catLabel) + '</span>' +
                '</div>' +
                '<div class="wf-author">by ' + safeHTML(author) + ' &middot; ' + ts + ' &middot; v' + safeHTML(p.version) + '</div>' +
                '<div class="wf-desc">' + safeHTML(p.description) + '</div>' +
                '<div class="wf-meta">' +
                '<span>' + p.nodeCount + ' nodes</span>' +
                '<span>' + p.complexity + '</span>' +
                '<span>~' + p.estTime + '</span>' +
                '</div>' +
                (p.tags.length > 0 ? '<div class="wf-tags">' + p.tags.map(function (t) { return '<span>' + safeHTML(t) + '</span>'; }).join('') + '</div>' : '') +
                '<div class="wf-actions">' +
                '<button class="btn-dim" data-wf-import=\'' + (ev.content || '').replace(/'/g, '&#39;') + '\'>IMPORT</button>' +
                '<button class="btn-dim" data-wf-detail="' + ev.id + '">DETAILS</button>' +
                '<button class="btn-dim" data-wf-react="' + ev.id + '" data-wf-pubkey="' + ev.pubkey + '">ZAP</button>' +
                '</div>' +
                '</div>';
        }).join('');
    }

    // ── WORKFLOW DETAIL VIEW ──
    function showWfDetail(eventId) {
        var ev = _workflowEvents.find(function (e) { return e.id === eventId; });
        if (!ev) return;
        var overlay = document.getElementById('wf-detail-overlay');
        if (!overlay) return;
        var p = parseWfContent(ev);
        var author = displayName(ev.pubkey);
        var ts = new Date(ev.created_at * 1000).toLocaleString();
        var catLabel = MP_CATEGORIES[p.category] || p.category;
        var wfJson = '';
        try {
            var raw = typeof p.raw.workflow === 'string' ? JSON.parse(p.raw.workflow) : p.raw.workflow;
            wfJson = JSON.stringify(raw, null, 2);
        } catch (e) { wfJson = typeof p.raw.workflow === 'string' ? p.raw.workflow : JSON.stringify(p.raw, null, 2); }

        var gistUrl = p.raw.gistUrl || '';
        var gistId = p.raw.gistId || '';
        // Try to extract gist ID from URL if we have URL but not ID
        if (gistUrl && !gistId) {
            var gistMatch = gistUrl.match(/([a-f0-9]{20,})/i);
            if (gistMatch) gistId = gistMatch[1];
        }

        var gistSection = '';
        if (gistUrl) {
            gistSection = '<div class="wf-detail-section">' +
                '<div class="wf-detail-section-title">GITHUB GIST (VERSIONED SOURCE)</div>' +
                '<div class="wf-detail-body">' +
                '<a href="' + safeHTML(gistUrl) + '" style="color:var(--accent);font-size:10px;">' + safeHTML(gistUrl) + '</a>' +
                '</div>' +
                '</div>';
        }

        overlay.innerHTML =
            '<button class="btn-dim wf-detail-back" id="wf-detail-back">&larr; BACK TO MARKETPLACE</button>' +
            '<div class="wf-detail-title">' + safeHTML(p.name) + '</div>' +
            '<div class="wf-detail-meta">' +
            'by <strong>' + safeHTML(author) + '</strong> &middot; ' + ts + ' &middot; ' +
            '<span style="color:var(--accent);">' + safeHTML(catLabel) + '</span> &middot; v' + safeHTML(p.version) +
            (gistUrl ? ' &middot; <span style="color:var(--green);">Gist-backed</span>' : '') +
            '</div>' +
            '<div class="wf-detail-section">' +
            '<div class="wf-detail-section-title">DESCRIPTION</div>' +
            '<div class="wf-detail-body">' + safeHTML(p.description) + '</div>' +
            '</div>' +
            '<div class="wf-detail-section">' +
            '<div class="wf-detail-section-title">SPECIFICATIONS</div>' +
            '<div class="wf-detail-body">' +
            '<strong>Nodes:</strong> ' + p.nodeCount + ' &middot; ' +
            '<strong>Complexity:</strong> ' + p.complexity + ' &middot; ' +
            '<strong>Est. Time:</strong> ' + p.estTime + ' &middot; ' +
            '<strong>Publisher:</strong> ' + ev.pubkey.slice(0, 16) + '...' +
            '</div>' +
            '</div>' +
            gistSection +
            (p.tags.length > 0 ? '<div class="wf-detail-section"><div class="wf-detail-section-title">TAGS</div><div class="wf-tags">' + p.tags.map(function (t) { return '<span>' + safeHTML(t) + '</span>'; }).join('') + '</div></div>' : '') +
            '<div class="wf-detail-section">' +
            '<div class="wf-detail-section-title">WORKFLOW DEFINITION</div>' +
            '<pre>' + safeHTML(wfJson) + '</pre>' +
            '</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">' +
            '<button data-wf-import=\'' + (ev.content || '').replace(/'/g, '&#39;') + '\'>IMPORT WORKFLOW</button>' +
            (gistId ? '<button data-wf-fork="' + gistId + '">FORK (ITERATE)</button>' : '') +
            (gistId ? '<button class="btn-dim" data-wf-history="' + gistId + '">VERSION HISTORY</button>' : '') +
            '<button data-wf-react="' + ev.id + '" data-wf-pubkey="' + ev.pubkey + '">ZAP</button>' +
            '<button class="btn-dim" id="wf-detail-back2">&larr; BACK</button>' +
            '</div>';
        overlay.classList.add('visible');
    }

    // ── DM CONVERSATIONS LIST ──
    function getDMPeers() {
        var peers = {};
        _dmMessages.forEach(function (d) {
            var pk = d.peerPubkey;
            if (!pk) return;
            if (!peers[pk]) peers[pk] = { lastTs: 0, count: 0 };
            peers[pk].count++;
            if (d.event.created_at > peers[pk].lastTs) peers[pk].lastTs = d.event.created_at;
        });
        return Object.keys(peers).map(function (pk) { return { pubkey: pk, lastTs: peers[pk].lastTs, count: peers[pk].count }; })
            .sort(function (a, b) { return b.lastTs - a.lastTs; });
    }

    function renderDMConversations() {
        var el = document.getElementById('dm-conv-list');
        if (!el) return;
        var peers = getDMPeers();
        if (peers.length === 0) {
            el.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:12px;font-size:10px;">No conversations yet</div>';
            return;
        }
        el.innerHTML = peers.map(function (p) {
            var active = p.pubkey === _activeDMPeer;
            var ts = new Date(p.lastTs * 1000).toLocaleTimeString();
            return '<div class="dm-conv-item' + (active ? ' active' : '') + '" data-dm-peer="' + p.pubkey + '">' +
                '<span class="dm-conv-name">' + safeHTML(displayName(p.pubkey)) + '</span>' +
                '<span class="dm-conv-time">' + p.count + ' msgs &middot; ' + ts + '</span>' +
                '</div>';
        }).join('');
    }

    function renderDMThread() {
        var feed = document.getElementById('dm-thread-feed');
        if (!feed) return;
        if (!_activeDMPeer) {
            feed.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:20px;font-size:10px;">Select a conversation or start a new DM</div>';
            return;
        }
        var msgs = _dmMessages.filter(function (d) { return d.peerPubkey === _activeDMPeer; });
        if (msgs.length === 0) {
            feed.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:20px;font-size:10px;">No messages in this conversation</div>';
            return;
        }
        feed.innerHTML = msgs.map(function (d) {
            var isSelf = d.event.pubkey === _nostrPubkey;
            var ts = new Date(d.event.created_at * 1000).toLocaleTimeString();
            return '<div class="community-msg">' +
                '<span class="msg-author" style="' + (isSelf ? 'color:var(--accent);' : '') + '">' + (isSelf ? 'You' : safeHTML(displayName(d.peerPubkey))) + '</span>' +
                '<span class="msg-time">' + ts + '</span>' +
                '<div class="msg-text">' + safeHTML(d.decrypted) + '</div>' +
                '</div>';
        }).join('');
        feed.scrollTop = feed.scrollHeight;
    }

    // ── CONTEXT MENU ──
    var _ctxMenu = document.getElementById('ctx-menu');
    function showContextMenu(x, y, msgId, msgPubkey) {
        if (!_ctxMenu) return;
        var isSelf = msgPubkey === _nostrPubkey;
        var items = [];
        if (!isSelf) {
            items.push('<button class="ctx-menu-item" data-ctx-action="dm" data-ctx-pk="' + msgPubkey + '">Send DM</button>');
            items.push('<button class="ctx-menu-item danger" data-ctx-action="block" data-ctx-pk="' + msgPubkey + '">Block User</button>');
        }
        if (isSelf) {
            items.push('<button class="ctx-menu-item danger" data-ctx-action="delete" data-ctx-id="' + msgId + '">Delete Message</button>');
        }
        items.push('<button class="ctx-menu-item" data-ctx-action="copy" data-ctx-pk="' + msgPubkey + '">Copy Pubkey</button>');
        _ctxMenu.innerHTML = items.join('');
        // Show off-screen first to measure, then clamp to viewport
        _ctxMenu.style.left = '-9999px';
        _ctxMenu.style.top = '-9999px';
        _ctxMenu.style.display = 'block';
        var mw = _ctxMenu.offsetWidth;
        var mh = _ctxMenu.offsetHeight;
        var vw = document.documentElement.clientWidth;
        var vh = document.documentElement.clientHeight;
        var pad = 4;
        // Clamp horizontal: prefer right-aligned to trigger, flip left if needed
        var left = x;
        if (left + mw > vw - pad) left = vw - mw - pad;
        if (left < pad) left = pad;
        // Clamp vertical: prefer below trigger, flip above if needed
        var top = y;
        if (top + mh > vh - pad) top = y - mh - 4;
        if (top < pad) top = pad;
        _ctxMenu.style.left = left + 'px';
        _ctxMenu.style.top = top + 'px';
    }
    function hideContextMenu() {
        if (_ctxMenu) _ctxMenu.style.display = 'none';
    }
    document.addEventListener('click', function (e) {
        // Context menu trigger
        var ctxBtn = e.target.closest('[data-ctx-msg]');
        if (ctxBtn) {
            var rect = ctxBtn.getBoundingClientRect();
            showContextMenu(rect.left, rect.bottom + 2, ctxBtn.dataset.ctxMsg, ctxBtn.dataset.ctxPubkey);
            e.stopPropagation();
            return;
        }
        // Context menu actions
        var ctxAction = e.target.closest('[data-ctx-action]');
        if (ctxAction) {
            var action = ctxAction.dataset.ctxAction;
            if (action === 'dm') {
                _activeDMPeer = ctxAction.dataset.ctxPk;
                // Switch to DMs tab
                document.querySelectorAll('#community-tabs button').forEach(function (b) { b.classList.remove('active'); });
                document.querySelector('[data-ctab="dms"]').classList.add('active');
                document.querySelectorAll('.community-subtab').forEach(function (t) { t.style.display = 'none'; });
                document.getElementById('ctab-dms').style.display = 'block';
                var dmInput = document.getElementById('dm-input');
                var dmSend = document.getElementById('dm-send');
                if (dmInput) { dmInput.disabled = false; dmInput.focus(); }
                if (dmSend) dmSend.disabled = false;
                renderDMConversations();
                renderDMThread();
            } else if (action === 'block') {
                vscode.postMessage({ command: 'nostrBlockUser', pubkey: ctxAction.dataset.ctxPk });
            } else if (action === 'delete') {
                vscode.postMessage({ command: 'nostrDeleteEvent', eventId: ctxAction.dataset.ctxId });
            } else if (action === 'copy') {
                var ta = document.createElement('textarea');
                ta.value = ctxAction.dataset.ctxPk;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            hideContextMenu();
            return;
        }
        // Reaction buttons — with optimistic UI feedback
        var reactBtn = e.target.closest('[data-react-id]');
        if (reactBtn) {
            var rEvId = reactBtn.dataset.reactId;
            var rEmoji = reactBtn.dataset.reactEmoji || '+';
            vscode.postMessage({
                command: 'nostrReact',
                eventId: rEvId,
                eventPubkey: reactBtn.dataset.reactPk,
                reaction: rEmoji
            });
            // Optimistic update — increment count and mark as self-reacted
            if (!_reactions[rEvId]) _reactions[rEvId] = { selfReacted: {} };
            if (!_reactions[rEvId].selfReacted[rEmoji]) {
                _reactions[rEvId][rEmoji] = (_reactions[rEvId][rEmoji] || 0) + 1;
                _reactions[rEvId].selfReacted[rEmoji] = true;
            }
            // Brief flash feedback on the button itself
            reactBtn.classList.add('reacted');
            renderChatFeed();
            return;
        }
        hideContextMenu();
    });

    // ── CHAT SEND ──
    var chatSendBtn = document.getElementById('nostr-chat-send');
    if (chatSendBtn) {
        chatSendBtn.addEventListener('click', function () {
            var input = document.getElementById('nostr-chat-input');
            if (input && input.value.trim()) {
                vscode.postMessage({ command: 'nostrPublishChat', message: input.value.trim() });
                input.value = '';
                var warn = document.getElementById('chat-redact-warn');
                if (warn) warn.classList.remove('visible');
            }
        });
    }
    var chatInput = document.getElementById('nostr-chat-input');
    if (chatInput) {
        chatInput.addEventListener('keyup', function (e) {
            if (e.key === 'Enter') {
                document.getElementById('nostr-chat-send').click();
                return;
            }
            // Live redaction preview
            clearTimeout(_redactTimer);
            _redactTimer = setTimeout(function () {
                if (chatInput.value.trim()) {
                    vscode.postMessage({ command: 'nostrRedactPreview', text: chatInput.value });
                } else {
                    var w = document.getElementById('chat-redact-warn');
                    if (w) w.classList.remove('visible');
                }
            }, 300);
        });
    }

    // ── DM SEND ──
    var dmSendBtn = document.getElementById('dm-send');
    if (dmSendBtn) {
        dmSendBtn.addEventListener('click', function () {
            var input = document.getElementById('dm-input');
            if (input && input.value.trim() && _activeDMPeer) {
                vscode.postMessage({ command: 'nostrSendDM', recipientPubkey: _activeDMPeer, message: input.value.trim() });
                // Optimistic local add
                _dmMessages.push({
                    event: { id: 'local_' + Date.now(), pubkey: _nostrPubkey, created_at: Math.floor(Date.now() / 1000), kind: 4, tags: [['p', _activeDMPeer]], content: '', sig: '' },
                    decrypted: input.value.trim(),
                    peerPubkey: _activeDMPeer
                });
                input.value = '';
                renderDMThread();
                var w = document.getElementById('dm-redact-warn');
                if (w) w.classList.remove('visible');
            }
        });
    }
    var dmInput = document.getElementById('dm-input');
    if (dmInput) {
        dmInput.addEventListener('keyup', function (e) {
            if (e.key === 'Enter') {
                document.getElementById('dm-send').click();
                return;
            }
            clearTimeout(_redactTimer);
            _redactTimer = setTimeout(function () {
                if (dmInput.value.trim()) {
                    vscode.postMessage({ command: 'nostrRedactPreview', text: dmInput.value });
                } else {
                    var w = document.getElementById('dm-redact-warn');
                    if (w) w.classList.remove('visible');
                }
            }, 300);
        });
    }

    // ── DM CONVERSATION SELECTION ──
    var dmConvList = document.getElementById('dm-conv-list');
    if (dmConvList) {
        dmConvList.addEventListener('click', function (e) {
            var item = e.target.closest('[data-dm-peer]');
            if (item) {
                _activeDMPeer = item.dataset.dmPeer;
                var dmInputEl = document.getElementById('dm-input');
                var dmSendEl = document.getElementById('dm-send');
                if (dmInputEl) { dmInputEl.disabled = false; dmInputEl.focus(); }
                if (dmSendEl) dmSendEl.disabled = false;
                renderDMConversations();
                renderDMThread();
            }
        });
    }

    // ── NEW DM BUTTON ──
    var newDMBtn = document.getElementById('nostr-new-dm');
    if (newDMBtn) {
        newDMBtn.addEventListener('click', function () {
            var pk = prompt('Enter recipient public key (hex):');
            if (pk && pk.length >= 32) {
                _activeDMPeer = pk.trim();
                var dmInputEl = document.getElementById('dm-input');
                var dmSendEl = document.getElementById('dm-send');
                if (dmInputEl) { dmInputEl.disabled = false; dmInputEl.focus(); }
                if (dmSendEl) dmSendEl.disabled = false;
                renderDMConversations();
                renderDMThread();
            }
        });
    }

    // ── FETCH BUTTONS ──
    var fetchWfBtn = document.getElementById('nostr-fetch-wf');
    if (fetchWfBtn) {
        fetchWfBtn.addEventListener('click', function () {
            vscode.postMessage({ command: 'nostrFetchWorkflows' });
        });
    }
    var fetchChatBtn = document.getElementById('nostr-fetch-chat');
    if (fetchChatBtn) {
        fetchChatBtn.addEventListener('click', function () {
            vscode.postMessage({ command: 'nostrFetchChat' });
        });
    }
    var fetchDMsBtn = document.getElementById('nostr-fetch-dms');
    if (fetchDMsBtn) {
        fetchDMsBtn.addEventListener('click', function () {
            vscode.postMessage({ command: 'nostrFetchDMs' });
        });
    }
    var publishWfBtn = document.getElementById('nostr-publish-wf');
    if (publishWfBtn) {
        publishWfBtn.addEventListener('click', function () {
            var el = document.getElementById('publish-wf-modal');
            if (el) el.classList.add('active');
        });
    }

    // ── MARKETPLACE SEARCH ──
    var mpSearchInput = document.getElementById('mp-search');
    var _mpSearchTimer = null;
    if (mpSearchInput) {
        mpSearchInput.addEventListener('input', function () {
            clearTimeout(_mpSearchTimer);
            _mpSearchTimer = setTimeout(function () {
                _mpFilter.search = mpSearchInput.value.trim();
                renderWorkflowFeed();
            }, 250);
        });
    }
    // ── MARKETPLACE SORT ──
    var mpSortSelect = document.getElementById('mp-sort');
    if (mpSortSelect) {
        mpSortSelect.addEventListener('change', function () {
            _mpFilter.sort = mpSortSelect.value;
            renderWorkflowFeed();
        });
    }
    // ── MARKETPLACE CATEGORY PILLS (event delegation) ──
    var mpCatsEl = document.getElementById('mp-categories');
    if (mpCatsEl) {
        mpCatsEl.addEventListener('click', function (e) {
            var pill = e.target.closest('[data-mp-cat]');
            if (pill) {
                _mpFilter.category = pill.dataset.mpCat;
                renderWorkflowFeed();
            }
        });
    }
    // ── WORKFLOW FEED + DETAIL DELEGATION ──
    document.addEventListener('click', function (e) {
        // Detail back buttons
        if (e.target.id === 'wf-detail-back' || e.target.id === 'wf-detail-back2') {
            var overlay = document.getElementById('wf-detail-overlay');
            if (overlay) overlay.classList.remove('visible');
            return;
        }
        // Detail view button
        var detailBtn = e.target.closest('[data-wf-detail]');
        if (detailBtn) {
            showWfDetail(detailBtn.dataset.wfDetail);
            return;
        }
        // Fork button (Gist)
        var forkBtn = e.target.closest('[data-wf-fork]');
        if (forkBtn) {
            if (!_ghAuthenticated) {
                vscode.postMessage({ command: 'githubAuth' });
                return;
            }
            vscode.postMessage({ command: 'githubForkGist', gistId: forkBtn.dataset.wfFork });
            return;
        }
        // History button (Gist)
        var histBtn = e.target.closest('[data-wf-history]');
        if (histBtn) {
            vscode.postMessage({ command: 'githubGetHistory', gistId: histBtn.dataset.wfHistory });
            return;
        }
        // Import from Gist button
        var importGistModalBtn = e.target.closest('#mp-import-gist-btn');
        if (importGistModalBtn) {
            var modal = document.getElementById('import-gist-modal');
            if (modal) modal.classList.add('active');
            return;
        }
        // Import button
        var importBtn = e.target.closest('[data-wf-import]');
        if (importBtn) {
            try {
                var wfData = JSON.parse(importBtn.dataset.wfImport);
                if (wfData.workflow) callTool('workflow_create', { definition: wfData.workflow });
            } catch (err) { console.error('[Community] Import failed:', err); }
            return;
        }
        // Zap/react button
        var reactBtn = e.target.closest('[data-wf-react]');
        if (reactBtn) {
            vscode.postMessage({ command: 'nostrReact', eventId: reactBtn.dataset.wfReact, eventPubkey: reactBtn.dataset.wfPubkey, reaction: '+' });
        }
    });

    // ── PRIVACY TOGGLES ──
    document.querySelectorAll('[data-privacy]').forEach(function (toggle) {
        toggle.addEventListener('click', function () {
            var key = toggle.dataset.privacy;
            var newVal = !toggle.classList.contains('on');
            toggle.classList.toggle('on', newVal);
            var update = {};
            update[key] = newVal;
            vscode.postMessage({ command: 'nostrSetPrivacy', settings: update });
        });
    });

    // ── PROFILE BUTTON ──
    var profileBtn = document.getElementById('nostr-profile-btn');
    if (profileBtn) {
        profileBtn.addEventListener('click', function () {
            var name = prompt('Display name (visible to community):');
            if (name !== null) {
                vscode.postMessage({ command: 'nostrSetProfile', profile: { name: name.trim() || undefined } });
            }
        });
    }

    // ── GITHUB STATE ──
    var _ghAuthenticated = false;
    var _ghUsername = null;
    var _pendingGistPublish = null; // holds workflow data while Gist is being created
    var _myGists = [];

    function handleGitHubAuth(msg) {
        _ghAuthenticated = msg.authenticated;
        _ghUsername = msg.username || null;
        var dot = document.getElementById('gh-dot');
        var uname = document.getElementById('gh-username');
        var btn = document.getElementById('gh-auth-btn');
        if (dot) dot.className = 'dot ' + (_ghAuthenticated ? 'green pulse' : 'off');
        if (uname) uname.textContent = _ghAuthenticated ? _ghUsername : 'Not connected';
        if (btn) btn.textContent = _ghAuthenticated ? 'DISCONNECT' : 'CONNECT';
        // Update gist status in publish modal
        var gistStatus = document.getElementById('pub-wf-gist-status');
        if (gistStatus) gistStatus.textContent = _ghAuthenticated ? 'as ' + _ghUsername : 'requires GitHub login';
    }

    function handleGistCreated(gist) {
        if (!gist) return;
        console.log('[GitHub] Gist created:', gist.url);
        // If we have a pending publish, now publish to Nostr with the gist URL
        if (_pendingGistPublish) {
            var p = _pendingGistPublish;
            _pendingGistPublish = null;
            vscode.postMessage({
                command: 'nostrPublishWorkflow',
                name: p.name, description: p.description, workflow: p.workflow,
                tags: p.tags, category: p.category, version: p.version,
                complexity: p.complexity, estTime: p.estTime,
                gistUrl: gist.url, gistId: gist.id
            });
        }
    }
    function handleGistUpdated(gist) {
        if (gist) console.log('[GitHub] Gist updated:', gist.url);
    }
    function handleGistForked(gist) {
        if (!gist) return;
        console.log('[GitHub] Forked to:', gist.url);
        // Show in detail view
        var overlay = document.getElementById('wf-detail-overlay');
        if (overlay && overlay.classList.contains('visible')) {
            var notice = document.createElement('div');
            notice.style.cssText = 'padding:8px 12px;background:rgba(0,255,150,0.1);border:1px solid var(--green);color:var(--green);font-size:10px;margin-top:8px;';
            notice.innerHTML = 'Forked! Your copy: <a href="' + safeHTML(gist.url) + '" style="color:var(--accent);">' + safeHTML(gist.url) + '</a>';
            overlay.appendChild(notice);
        }
    }
    function handleGistHistory(gistId, history) {
        if (!history || !history.length) return;
        var overlay = document.getElementById('wf-detail-overlay');
        if (!overlay || !overlay.classList.contains('visible')) return;
        // Find or create history section
        var existing = document.getElementById('wf-history-section');
        if (existing) existing.remove();
        var section = document.createElement('div');
        section.id = 'wf-history-section';
        section.className = 'wf-detail-section';
        section.innerHTML = '<div class="wf-detail-section-title">VERSION HISTORY (' + history.length + ' revisions)</div>' +
            '<div style="border:1px solid var(--border);max-height:150px;overflow-y:auto;">' +
            history.map(function (h, i) {
                var ts = new Date(h.committed_at).toLocaleString();
                var changes = h.change_status || {};
                return '<div style="padding:6px 12px;border-bottom:1px solid var(--border);font-size:10px;display:flex;justify-content:space-between;">' +
                    '<span>' + (i === 0 ? '<strong>Latest</strong>' : 'Rev ' + (history.length - i)) + ' &middot; ' + ts + '</span>' +
                    '<span style="color:var(--text-dim);">+' + (changes.additions || 0) + ' -' + (changes.deletions || 0) + '</span>' +
                    '</div>';
            }).join('') +
            '</div>';
        // Insert before the workflow definition section
        var defSection = overlay.querySelector('.wf-detail-section:last-of-type');
        if (defSection) overlay.insertBefore(section, defSection);
        else overlay.appendChild(section);
    }
    function handleGistImported(result) {
        closeModals();
        if (!result) {
            console.error('[GitHub] Import failed: no workflow found in Gist');
            return;
        }
        // Auto-populate the publish modal with imported data, or directly create the workflow
        if (result.workflow) {
            try {
                callTool('workflow_create', { definition: result.workflow });
                console.log('[GitHub] Imported workflow:', result.name);
            } catch (err) { console.error('[GitHub] Import create failed:', err); }
        }
    }
    function handleMyGists(gists) {
        _myGists = gists || [];
    }

    // ── GITHUB AUTH BUTTON ──
    var ghAuthBtn = document.getElementById('gh-auth-btn');
    if (ghAuthBtn) {
        ghAuthBtn.addEventListener('click', function () {
            if (_ghAuthenticated) {
                vscode.postMessage({ command: 'githubSignOut' });
            } else {
                vscode.postMessage({ command: 'githubAuth' });
            }
        });
    }

    // ── IMPORT FROM GIST MODAL ──
    var importGistBtn = document.getElementById('import-gist-btn');
    if (importGistBtn) {
        importGistBtn.addEventListener('click', function () {
            var urlInput = document.getElementById('import-gist-url');
            if (urlInput && urlInput.value.trim()) {
                vscode.postMessage({ command: 'githubImportFromUrl', url: urlInput.value.trim() });
                urlInput.value = '';
            }
        });
    }

    function doPublishWorkflow() {
        var name = document.getElementById('pub-wf-name').value;
        var desc = document.getElementById('pub-wf-desc').value;
        var json = document.getElementById('pub-wf-json').value;
        var tagsStr = document.getElementById('pub-wf-tags').value;
        var category = (document.getElementById('pub-wf-category') || {}).value || 'other';
        var version = (document.getElementById('pub-wf-version') || {}).value || '1.0.0';
        var complexity = (document.getElementById('pub-wf-complexity') || {}).value || 'moderate';
        var estTime = (document.getElementById('pub-wf-time') || {}).value || 'fast';
        var gistCheckbox = document.getElementById('pub-wf-gist');
        var backWithGist = gistCheckbox ? gistCheckbox.checked : false;
        if (!name || !json) return;
        var tags = tagsStr ? tagsStr.split(',').map(function (t) { return t.trim(); }).filter(Boolean) : [];

        var meta = { category: category, version: version, complexity: complexity, estTime: estTime };

        if (backWithGist && _ghAuthenticated) {
            // Create Gist first, then publish to Nostr with Gist URL
            _pendingGistPublish = {
                name: name, description: desc, workflow: json,
                tags: tags, category: category, version: version,
                complexity: complexity, estTime: estTime
            };
            vscode.postMessage({
                command: 'githubCreateGist',
                name: name, workflow: json, description: desc,
                isPublic: true, meta: meta
            });
        } else {
            // Direct Nostr publish (no Gist)
            vscode.postMessage({
                command: 'nostrPublishWorkflow',
                name: name, description: desc, workflow: json,
                tags: tags, category: category, version: version,
                complexity: complexity, estTime: estTime
            });
        }
        closeModals();
    }
    window.doPublishWorkflow = doPublishWorkflow;

    // ══════════════════════════════════════════════════════════════════
    // UX THEME ENGINE
    // ══════════════════════════════════════════════════════════════════
    // Security-first preset analysis:
    //   Commander (default) — balanced info density, standard pubkey display, presence ON
    //   Operator — max data density, all metrics visible, compact but full exposure
    //   Observer — read-only feel, larger type, relaxed, standard privacy
    //   Stealth — HIDES pubkeys, disables presence, kills identity bar, max redaction,
    //             no reactions (prevents behavioral fingerprinting), timestamps relative
    //             (prevents timezone inference), no online bar (prevents presence tracking)
    //   Accessible — high contrast, large fonts, no motion, focus indicators,
    //                hidden pubkeys (screen reader safety), aria hints ON
    // ══════════════════════════════════════════════════════════════════

    var UX_DEFAULTS = {
        preset: 'commander',
        // Layout
        density: 'standard', spacing: 12, borderRadius: 0, cardPadding: 12,
        // Typography
        fontSize: 12, lineHeight: 15, headerSize: 14, fontFamily: 'mono',
        // Colors
        accentColor: '#00ff88', surfaceColor: '#1a1a2e', borderColor: '#2a2a4a',
        dimOpacity: 55, contrast: 'normal',
        // Motion
        transitions: true, pulseEffects: true, transitionSpeed: 150, smoothScroll: true,
        // Info density
        cardDetail: 'standard', truncateLength: 120, timestampFormat: 'time',
        showStats: true, compactMessages: false,
        // Privacy appearance
        pubkeyDisplay: 'short', showOnlineBar: true, showIdentityBar: true, showReactions: true,
        // Notifications
        showRedactWarn: true, errorDisplay: 'inline', showSuccess: true,
        // Accessibility
        reducedMotion: false, highContrast: false, focusIndicators: true, ariaHints: false
    };

    var UX_PRESETS = {
        commander: {
            preset: 'commander',
            density: 'standard', spacing: 12, borderRadius: 0, cardPadding: 12,
            fontSize: 12, lineHeight: 15, headerSize: 14, fontFamily: 'mono',
            accentColor: '#00ff88', surfaceColor: '#1a1a2e', borderColor: '#2a2a4a',
            dimOpacity: 55, contrast: 'normal',
            transitions: true, pulseEffects: true, transitionSpeed: 150, smoothScroll: true,
            cardDetail: 'standard', truncateLength: 120, timestampFormat: 'time',
            showStats: true, compactMessages: false,
            pubkeyDisplay: 'short', showOnlineBar: true, showIdentityBar: true, showReactions: true,
            showRedactWarn: true, errorDisplay: 'inline', showSuccess: true,
            reducedMotion: false, highContrast: false, focusIndicators: true, ariaHints: false
        },
        operator: {
            preset: 'operator',
            density: 'compact', spacing: 6, borderRadius: 0, cardPadding: 8,
            fontSize: 10, lineHeight: 13, headerSize: 12, fontFamily: 'mono',
            accentColor: '#00ff88', surfaceColor: '#111122', borderColor: '#222244',
            dimOpacity: 45, contrast: 'normal',
            transitions: true, pulseEffects: true, transitionSpeed: 80, smoothScroll: true,
            cardDetail: 'full', truncateLength: 200, timestampFormat: 'time',
            showStats: true, compactMessages: true,
            pubkeyDisplay: 'short', showOnlineBar: true, showIdentityBar: true, showReactions: true,
            showRedactWarn: true, errorDisplay: 'inline', showSuccess: true,
            reducedMotion: false, highContrast: false, focusIndicators: true, ariaHints: false
        },
        observer: {
            preset: 'observer',
            density: 'spacious', spacing: 18, borderRadius: 4, cardPadding: 16,
            fontSize: 14, lineHeight: 18, headerSize: 16, fontFamily: 'sans',
            accentColor: '#00cc88', surfaceColor: '#1a1a2e', borderColor: '#2a2a4a',
            dimOpacity: 55, contrast: 'normal',
            transitions: true, pulseEffects: false, transitionSpeed: 250, smoothScroll: true,
            cardDetail: 'standard', truncateLength: 160, timestampFormat: 'relative',
            showStats: true, compactMessages: false,
            pubkeyDisplay: 'short', showOnlineBar: true, showIdentityBar: true, showReactions: true,
            showRedactWarn: true, errorDisplay: 'inline', showSuccess: true,
            reducedMotion: false, highContrast: false, focusIndicators: true, ariaHints: false
        },
        stealth: {
            preset: 'stealth',
            density: 'standard', spacing: 10, borderRadius: 0, cardPadding: 10,
            fontSize: 11, lineHeight: 14, headerSize: 13, fontFamily: 'mono',
            accentColor: '#666688', surfaceColor: '#0a0a14', borderColor: '#1a1a2a',
            dimOpacity: 35, contrast: 'normal',
            transitions: false, pulseEffects: false, transitionSpeed: 0, smoothScroll: false,
            cardDetail: 'minimal', truncateLength: 80, timestampFormat: 'relative',
            showStats: false, compactMessages: true,
            pubkeyDisplay: 'hidden', showOnlineBar: false, showIdentityBar: false, showReactions: false,
            showRedactWarn: true, errorDisplay: 'silent', showSuccess: false,
            reducedMotion: true, highContrast: false, focusIndicators: false, ariaHints: false
        },
        accessible: {
            preset: 'accessible',
            density: 'spacious', spacing: 16, borderRadius: 4, cardPadding: 16,
            fontSize: 16, lineHeight: 22, headerSize: 18, fontFamily: 'system',
            accentColor: '#44ddff', surfaceColor: '#000000', borderColor: '#555555',
            dimOpacity: 70, contrast: 'ultra',
            transitions: false, pulseEffects: false, transitionSpeed: 0, smoothScroll: false,
            cardDetail: 'standard', truncateLength: 160, timestampFormat: 'full',
            showStats: true, compactMessages: false,
            pubkeyDisplay: 'hidden', showOnlineBar: true, showIdentityBar: true, showReactions: true,
            showRedactWarn: true, errorDisplay: 'inline', showSuccess: true,
            reducedMotion: true, highContrast: true, focusIndicators: true, ariaHints: true
        }
    };

    var _uxSettings = {};
    function uxGet(key) {
        return _uxSettings[key] !== undefined ? _uxSettings[key] : UX_DEFAULTS[key];
    }

    var FONT_MAP = {
        mono: "'Cascadia Code','Fira Code','Consolas',monospace",
        sans: "'Segoe UI','Helvetica Neue',sans-serif",
        system: "system-ui,-apple-system,sans-serif"
    };

    function applyUXToCSS() {
        var r = document.documentElement;
        var s = function (k, v) { r.style.setProperty(k, v); };
        var fs = uxGet('fontSize');
        s('--ux-font-size', fs + 'px');
        s('--ux-font-size-sm', Math.max(fs - 2, 8) + 'px');
        s('--ux-font-size-xs', Math.max(fs - 3, 7) + 'px');
        s('--ux-font-size-lg', (fs + 2) + 'px');
        s('--ux-spacing', uxGet('spacing') + 'px');
        s('--ux-spacing-sm', Math.max(uxGet('spacing') - 4, 2) + 'px');
        s('--ux-spacing-xs', Math.max(uxGet('spacing') - 8, 1) + 'px');
        s('--ux-radius', uxGet('borderRadius') + 'px');
        s('--ux-transition', uxGet('transitions') ? (uxGet('transitionSpeed') + 'ms') : '0s');
        s('--ux-msg-padding', uxGet('compactMessages') ? '4px 8px' : '8px 12px');
        s('--ux-card-padding', uxGet('cardPadding') + 'px ' + (uxGet('cardPadding') + 2) + 'px');
        s('--ux-header-size', uxGet('headerSize') + 'px');
        s('--ux-line-height', (uxGet('lineHeight') / 10).toFixed(1));
        s('--ux-opacity-dim', (uxGet('dimOpacity') / 100).toFixed(2));
        s('--accent', uxGet('accentColor'));
        s('--accent-dim', uxGet('accentColor') + '33');
        s('--surface', uxGet('surfaceColor'));
        s('--border', uxGet('borderColor'));
        s('--green', uxGet('accentColor'));
        s('--mono', FONT_MAP[uxGet('fontFamily')] || FONT_MAP.mono);
        // Contrast
        var ct = uxGet('contrast');
        if (ct === 'high') { s('--text', '#ffffff'); s('--text-dim', '#aaaaaa'); }
        else if (ct === 'ultra') { s('--text', '#ffffff'); s('--text-dim', '#cccccc'); s('--border', '#666666'); }
        else { s('--text', '#e0e0e0'); s('--text-dim', '#888888'); }
        // Body classes
        var body = document.body;
        body.classList.toggle('reduce-motion', uxGet('reducedMotion'));
        if (uxGet('smoothScroll')) body.style.scrollBehavior = 'smooth';
        else body.style.scrollBehavior = 'auto';
        // Visibility toggles
        var onlineBar = document.getElementById('online-bar');
        if (onlineBar) onlineBar.style.display = uxGet('showOnlineBar') ? '' : 'none';
        var idBar = document.getElementById('nostr-identity');
        if (idBar) idBar.style.display = uxGet('showIdentityBar') ? '' : 'none';
        var ghBar = document.getElementById('github-identity');
        if (ghBar) ghBar.style.display = uxGet('showIdentityBar') ? '' : 'none';
        var statsBar = document.getElementById('mp-stats');
        if (statsBar) statsBar.style.display = uxGet('showStats') ? '' : 'none';
        // Pulse effects
        if (!uxGet('pulseEffects')) {
            var pulses = document.querySelectorAll('.pulse');
            pulses.forEach(function (p) { p.classList.remove('pulse'); p.classList.add('no-pulse'); });
        }
    }

    function syncControlsToSettings() {
        // Sync range inputs
        document.querySelectorAll('[data-ux]').forEach(function (el) {
            var key = el.dataset.ux;
            var val = uxGet(key);
            if (el.tagName === 'SELECT') { el.value = val; }
            else if (el.type === 'range') {
                el.value = val;
                var valSpan = el.nextElementSibling;
                if (valSpan && valSpan.classList.contains('ux-range-val')) {
                    if (key === 'lineHeight') valSpan.textContent = (val / 10).toFixed(1);
                    else if (key === 'dimOpacity') valSpan.textContent = val + '%';
                    else if (key === 'transitionSpeed') valSpan.textContent = val + 'ms';
                    else if (key === 'truncateLength') valSpan.textContent = val;
                    else valSpan.textContent = val + 'px';
                }
            } else if (el.type === 'color') { el.value = val; }
        });
        // Sync toggles
        document.querySelectorAll('[data-ux-toggle]').forEach(function (el) {
            var key = el.dataset.uxToggle;
            el.classList.toggle('on', !!uxGet(key));
        });
        // Sync preset cards
        document.querySelectorAll('[data-ux-preset]').forEach(function (el) {
            el.classList.toggle('active', el.dataset.uxPreset === uxGet('preset'));
        });
        // Update category summary values
        var valLayout = document.getElementById('ux-val-layout');
        if (valLayout) valLayout.textContent = uxGet('density');
        var valTypo = document.getElementById('ux-val-typography');
        if (valTypo) valTypo.textContent = uxGet('fontSize') + 'px ' + uxGet('fontFamily');
        var valColors = document.getElementById('ux-val-colors');
        if (valColors) valColors.textContent = uxGet('contrast') === 'normal' ? 'Custom' : uxGet('contrast');
        var valMotion = document.getElementById('ux-val-motion');
        if (valMotion) valMotion.textContent = uxGet('transitions') ? 'Enabled' : 'Off';
        var valInfo = document.getElementById('ux-val-info');
        if (valInfo) valInfo.textContent = uxGet('cardDetail');
        var valPriv = document.getElementById('ux-val-privappear');
        if (valPriv) valPriv.textContent = uxGet('pubkeyDisplay') === 'hidden' ? 'Stealth' : uxGet('pubkeyDisplay');
        var valNotif = document.getElementById('ux-val-notif');
        if (valNotif) valNotif.textContent = uxGet('errorDisplay');
        var valA11y = document.getElementById('ux-val-a11y');
        if (valA11y) valA11y.textContent = uxGet('reducedMotion') ? 'Reduced' : (uxGet('highContrast') ? 'High Contrast' : 'Default');
    }

    function handleUXSettings(settings) {
        _uxSettings = settings || {};
        applyUXToCSS();
        syncControlsToSettings();
    }

    function saveUX(partial) {
        Object.keys(partial).forEach(function (k) { _uxSettings[k] = partial[k]; });
        applyUXToCSS();
        syncControlsToSettings();
        vscode.postMessage({ command: 'uxSetSettings', settings: _uxSettings });
    }

    // ── CATEGORY EXPAND/COLLAPSE ──
    document.querySelectorAll('.ux-category-header').forEach(function (header) {
        header.addEventListener('click', function () {
            header.parentElement.classList.toggle('open');
        });
    });

    // ── PRESET CARD CLICKS ──
    document.querySelectorAll('[data-ux-preset]').forEach(function (card) {
        card.addEventListener('click', function () {
            var presetKey = card.dataset.uxPreset;
            var preset = UX_PRESETS[presetKey];
            if (preset) {
                _uxSettings = JSON.parse(JSON.stringify(preset));
                applyUXToCSS();
                syncControlsToSettings();
                vscode.postMessage({ command: 'uxSetSettings', settings: _uxSettings });
            }
        });
    });

    // ── RANGE INPUTS ──
    document.querySelectorAll('.ux-control input[type="range"]').forEach(function (input) {
        input.addEventListener('input', function () {
            var key = input.dataset.ux;
            var val = parseInt(input.value);
            var valSpan = input.nextElementSibling;
            if (valSpan && valSpan.classList.contains('ux-range-val')) {
                if (key === 'lineHeight') valSpan.textContent = (val / 10).toFixed(1);
                else if (key === 'dimOpacity') valSpan.textContent = val + '%';
                else if (key === 'transitionSpeed') valSpan.textContent = val + 'ms';
                else if (key === 'truncateLength') valSpan.textContent = val;
                else valSpan.textContent = val + 'px';
            }
            var update = {}; update[key] = val; update.preset = 'custom';
            saveUX(update);
        });
    });

    // ── SELECT INPUTS ──
    document.querySelectorAll('.ux-control select[data-ux]').forEach(function (sel) {
        sel.addEventListener('change', function () {
            var update = {}; update[sel.dataset.ux] = sel.value; update.preset = 'custom';
            saveUX(update);
        });
    });

    // ── COLOR INPUTS ──
    document.querySelectorAll('.ux-control input[type="color"]').forEach(function (input) {
        input.addEventListener('input', function () {
            var update = {}; update[input.dataset.ux] = input.value; update.preset = 'custom';
            saveUX(update);
        });
    });

    // ── TOGGLE SWITCHES ──
    document.querySelectorAll('[data-ux-toggle]').forEach(function (toggle) {
        toggle.addEventListener('click', function () {
            var key = toggle.dataset.uxToggle;
            var newVal = !toggle.classList.contains('on');
            toggle.classList.toggle('on', newVal);
            var update = {}; update[key] = newVal; update.preset = 'custom';
            saveUX(update);
        });
    });

    // ── EXPORT / IMPORT / RESET ──
    var uxExportBtn = document.getElementById('ux-export-btn');
    if (uxExportBtn) {
        uxExportBtn.addEventListener('click', function () {
            var json = JSON.stringify(_uxSettings, null, 2);
            var ta = document.createElement('textarea');
            ta.value = json; document.body.appendChild(ta);
            ta.select(); document.execCommand('copy');
            document.body.removeChild(ta);
            uxExportBtn.textContent = 'COPIED!';
            setTimeout(function () { uxExportBtn.textContent = 'EXPORT'; }, 1500);
        });
    }
    var uxImportBtn = document.getElementById('ux-import-btn');
    if (uxImportBtn) {
        uxImportBtn.addEventListener('click', function () {
            var json = prompt('Paste UX settings JSON:');
            if (json) {
                try {
                    var parsed = JSON.parse(json);
                    _uxSettings = parsed;
                    applyUXToCSS();
                    syncControlsToSettings();
                    vscode.postMessage({ command: 'uxSetSettings', settings: _uxSettings });
                } catch (e) { console.error('[UX] Import failed:', e); }
            }
        });
    }
    var uxResetBtn = document.getElementById('ux-reset-btn');
    if (uxResetBtn) {
        uxResetBtn.addEventListener('click', function () {
            _uxSettings = {};
            applyUXToCSS();
            syncControlsToSettings();
            vscode.postMessage({ command: 'uxResetSettings' });
        });
    }

    // ── INIT ──
    buildToolsRegistry();
    renderSlots([]);

    // Tell extension we're ready
    vscode.postMessage({ command: 'ready' });

    // Request Nostr identity on load
    vscode.postMessage({ command: 'nostrGetIdentity' });
    // Request privacy settings
    vscode.postMessage({ command: 'nostrGetPrivacy' });
    vscode.postMessage({ command: 'nostrGetBlockList' });
    // Request GitHub auth status
    vscode.postMessage({ command: 'githubGetAuth' });
    // Request UX settings
    vscode.postMessage({ command: 'uxGetSettings' });
    // Auto-fetch community content
    setTimeout(function () {
        vscode.postMessage({ command: 'nostrFetchWorkflows' });
        vscode.postMessage({ command: 'nostrFetchChat' });
        vscode.postMessage({ command: 'nostrFetchDMs' });
        vscode.postMessage({ command: 'nostrGetOnlineUsers' });
    }, 2000);
    // Periodic presence polling
    setInterval(function () {
        vscode.postMessage({ command: 'nostrGetOnlineUsers' });
    }, 60000);
})();

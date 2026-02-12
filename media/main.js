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
                    _state = msg;
                    updateHeader(msg);
                    updateCatBars(msg.categories);
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
            if (d.quine_hash) document.getElementById('ov-hash').textContent = d.quine_hash;
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

    var MEMORY_TOOLS = ['bag_catalog', 'bag_search', 'bag_get', 'bag_export', 'bag_induct', 'bag_forget', 'bag_put', 'pocket', 'summon', 'materialize'];
    var COUNCIL_TOOLS = ['council_status', 'all_slots', 'broadcast', 'council_broadcast', 'set_consensus', 'debate', 'chain', 'slot_info', 'get_slot_params', 'invoke_slot', 'plug_model', 'unplug_slot', 'clone_slot', 'mutate_slot', 'rename_slot', 'swap_slots', 'hub_plug', 'cull_slot'];

    function parseToolData(data) {
        if (data && data.content && Array.isArray(data.content) && data.content[0] && data.content[0].text) {
            return data.content[0].text;
        }
        if (typeof data === 'string') return data;
        return JSON.stringify(data, null, 2);
    }

    function handleToolResult(msg) {
        var toolName = _pendingTools[msg.id] || '';
        delete _pendingTools[msg.id];

        var text = msg.error ? 'ERROR: ' + msg.error : parseToolData(msg.data);

        // Route to Memory tab if it's a memory tool
        if (MEMORY_TOOLS.indexOf(toolName) >= 0) {
            var memList = document.getElementById('mem-list');
            if (memList) {
                memList.innerHTML = '<pre style="white-space:pre-wrap;word-break:break-word;color:var(--text);font-size:11px;">' +
                    text.substring(0, 10000).replace(/</g, '&lt;') + '</pre>';
            }
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

    // ── INIT ──
    buildToolsRegistry();
    renderSlots([]);

    // Tell extension we're ready
    vscode.postMessage({ command: 'ready' });
})();

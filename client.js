/*
 * dsh-model-dispatch — 模型分工（Model Dispatch）浏览器端 client bundle
 *
 * 设置页：settings.section「模型分工」— 任务类型×难度 → 模型矩阵、回退、并行数等；
 * 运行卡：tool.view.cordis「self」— 模式状态与用法摘要。
 *
 * 手写 bundle 遵循 DSH client-modules 协议：
 *   window.__ModuleLoader__.load({ id, factory })，
 *   factory(require) 返回 module.exports = { inject, apply }。
 */
window.__ModuleLoader__.load({
  id: "dsh-model-dispatch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    function errText(err) {
      if (!err) return '未知错误';
      if (typeof err === 'string') return err;
      return err.message || String(err);
    }

    function routeToValue(route) {
      return route && route.provider ? route.provider + '||' + (route.model || '') : '';
    }

    function fallbackValue(fb) {
      return fb && fb.provider ? fb.provider + '||' + (fb.model || '') : '';
    }

    function cellValue(routes, type, difficulty) {
      if (!Array.isArray(routes)) return '';
      for (var i = 0; i < routes.length; i++) {
        var r = routes[i];
        if (r && r.type === type && r.difficulty === difficulty) return routeToValue(r);
      }
      return '';
    }

    // 模型下拉：'' = 继承上级模型；'provider||model' = 定点路由
    function ModelSelect(props) {
      var catalog = props.catalog || [];
      var options = [React.createElement('option', { key: 'inherit', value: '' }, '继承上级模型')];
      for (var i = 0; i < catalog.length; i++) {
        var p = catalog[i];
        var kids = [];
        for (var j = 0; j < p.models.length; j++) {
          var m = p.models[j];
          kids.push(React.createElement('option', { key: m.id, value: p.provider + '||' + m.id }, m.name));
        }
        if (!kids.length) kids.push(React.createElement('option', { key: 'none', value: p.provider + '||', disabled: true }, '（无已录入模型）'));
        options.push(React.createElement('optgroup', { key: p.provider, label: p.name }, kids));
      }
      return React.createElement('select', {
        className: 'mdisp-select',
        value: props.value || '',
        onChange: function (ev) { props.onChange(ev.target.value); },
      }, options);
    }

    // ---------- 设置页 ----------
    function SettingsPage() {
      var st = React.useState(null);
      var state = st[0], setState = st[1];
      var sst = React.useState('');
      var status = sst[0], setStatus = sst[1];
      var it = React.useState('');
      var newType = it[0], setNewType = it[1];

      React.useEffect(function () {
        var alive = true;
        fetch('/api/mdisp/state').then(function (r) { return r.json() }).then(function (v) {
          if (!alive) return;
          if (v && v.config) v.draft = JSON.parse(JSON.stringify(v.config));
          setState(v);
        }).catch(function (err) {
          if (alive) setState({ error: errText(err) });
        });
        return function () { alive = false; };
      }, []);

      if (!state) return React.createElement('div', { className: 'mdisp-muted' }, '加载中…');
      if (state.error) return React.createElement('div', { className: 'mdisp-muted' }, '无法连接插件宿主：' + state.error);
      var cfg = state.config;
      if (!cfg) return React.createElement('div', { className: 'mdisp-muted' }, '配置不可用');
      var draft = state.draft || cfg;
      var catalog = state.catalog || [];
      var diagnostics = state.diagnostics || [];
      var modelCount = 0;
      for (var ci = 0; ci < catalog.length; ci++) modelCount += (catalog[ci].models || []).length;

      function reload() {
        setStatus('刷新目录…');
        fetch('/api/mdisp/state').then(function (r) { return r.json() }).then(function (v) {
          if (v && v.config) v.draft = JSON.parse(JSON.stringify(v.config));
          setState(v);
          setStatus('目录已刷新');
        }).catch(function (err) { setStatus('刷新失败：' + errText(err)); });
      }

      function updateDraft(fn) {
        setState(function (s) {
          var next = Object.assign({}, s);
          next.draft = JSON.parse(JSON.stringify(s.draft || s.config));
          fn(next.draft);
          return next;
        });
      }

      function setCell(type, difficulty, value) {
        updateDraft(function (d) {
          d.routes = d.routes.filter(function (r) { return !(r.type === type && r.difficulty === difficulty); });
          if (value) {
            var parts = value.split('||');
            d.routes.push({ type: type, difficulty: difficulty, provider: parts[0], model: parts[1] || '' });
          }
        });
      }

      function setFallback(difficulty, value) {
        updateDraft(function (d) {
          if (!value) { d.fallback[difficulty] = null; return; }
          var parts = value.split('||');
          d.fallback[difficulty] = { provider: parts[0], model: parts[1] || '' };
        });
      }

      function addType() {
        var t = newType.trim();
        if (!t) return;
        updateDraft(function (d) {
          if (d.taskTypes.indexOf(t) === -1) d.taskTypes.push(t);
        });
        setNewType('');
      }

      function removeType(t) {
        updateDraft(function (d) {
          d.taskTypes = d.taskTypes.filter(function (x) { return x !== t; });
          d.routes = d.routes.filter(function (r) { return r.type !== t; });
        });
      }

      function save() {
        setStatus('保存中…');
        fetch('/api/mdisp/save-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: draft }),
        }).then(function (r) { return r.json() }).then(function (v) {
          if (v && v.ok) {
            setStatus('已保存 ✔（本会话立即生效；新会话默认启用按全局开关）');
          } else {
            setStatus('保存失败：' + (v && v.error ? v.error : '未知错误'));
          }
        }).catch(function (err) {
          setStatus('保存失败：' + errText(err));
        });
      }

      var tableRows = draft.taskTypes.map(function (t) {
        return React.createElement('tr', { key: t }, [
          React.createElement('td', { key: 't' }, t + (TYPE_LABEL(t))),
          React.createElement('td', { key: 'h' }, React.createElement(ModelSelect, { catalog: catalog, value: cellValue(draft.routes, t, 'high'), onChange: function (v) { setCell(t, 'high', v); } })),
          React.createElement('td', { key: 'm' }, React.createElement(ModelSelect, { catalog: catalog, value: cellValue(draft.routes, t, 'medium'), onChange: function (v) { setCell(t, 'medium', v); } })),
          React.createElement('td', { key: 'l' }, React.createElement(ModelSelect, { catalog: catalog, value: cellValue(draft.routes, t, 'low'), onChange: function (v) { setCell(t, 'low', v); } })),
          React.createElement('td', { key: 'x' }, React.createElement('button', { className: 'mdisp-btn', onClick: function () { removeType(t); } }, '✕')),
        ]);
      });

      return React.createElement('div', { className: 'mdisp-wrap' }, [
        React.createElement('div', { key: 'title', className: 'mdisp-title' }, '模型分工（Model Dispatch）'),
        React.createElement('div', { key: 'desc', className: 'mdisp-muted' },
          '评估任务的类型与难度，按下方矩阵把任务路由给不同模型（通过 spawn 子代理执行，自动覆盖子代理的 provider/model）。' +
          '独立任务并行执行、重复任务合并、歧义任务先向你确认。配置持久化保存，重启不丢失。' +
          '开启方式：输入框左侧的「分工 开/关」药丸（按会话切换），或输入 /mdisp on、/mdisp off；上面的开关只决定新会话的默认值。'),

        React.createElement('div', { key: 'general', className: 'mdisp-card' }, [
          React.createElement('div', { key: 'e', className: 'mdisp-row' }, [
            React.createElement('label', { key: 'l', htmlFor: 'mdisp-enabled' }, '新会话默认启用该模式'),
            React.createElement('input', { key: 'i', id: 'mdisp-enabled', type: 'checkbox', checked: !!draft.enabled, onChange: function (ev) { updateDraft(function (d) { d.enabled = ev.target.checked; }); } }),
          ]),
          React.createElement('div', { key: 'a', className: 'mdisp-row' }, [
            React.createElement('label', { key: 'l', htmlFor: 'mdisp-ask' }, '歧义/信息不足时向用户提问确认'),
            React.createElement('input', { key: 'i', id: 'mdisp-ask', type: 'checkbox', checked: !!draft.askWhenAmbiguous, onChange: function (ev) { updateDraft(function (d) { d.askWhenAmbiguous = ev.target.checked; }); } }),
          ]),
          React.createElement('div', { key: 'p', className: 'mdisp-row' }, [
            React.createElement('label', { key: 'l', htmlFor: 'mdisp-par' }, '最大并行子代理数'),
            React.createElement('input', { key: 'i', id: 'mdisp-par', className: 'mdisp-input', type: 'number', min: 1, max: 8, value: draft.maxParallel, onChange: function (ev) { updateDraft(function (d) { d.maxParallel = Math.max(1, Math.min(8, parseInt(ev.target.value, 10) || 4)); }); } }),
          ]),
        ]),

        React.createElement('div', { key: 'fallback', className: 'mdisp-card' }, [
          React.createElement('div', { key: 't', className: 'mdisp-title' }, '通用回退（未定点配置的类型 × 难度）'),
          React.createElement('div', { key: 'r', className: 'mdisp-row' }, [
            React.createElement('span', { key: 'hl' }, '高难度'),
            React.createElement(ModelSelect, { key: 'hs', catalog: catalog, value: fallbackValue(draft.fallback.high), onChange: function (v) { setFallback('high', v); } }),
            React.createElement('span', { key: 'ml' }, '中难度'),
            React.createElement(ModelSelect, { key: 'ms', catalog: catalog, value: fallbackValue(draft.fallback.medium), onChange: function (v) { setFallback('medium', v); } }),
            React.createElement('span', { key: 'll' }, '低难度'),
            React.createElement(ModelSelect, { key: 'ls', catalog: catalog, value: fallbackValue(draft.fallback.low), onChange: function (v) { setFallback('low', v); } }),
          ]),
          React.createElement('div', { key: 'hint', className: 'mdisp-muted' }, '「继承上级模型」表示不指定，子代理沿用当前会话的模型。'),
        ]),

        React.createElement('div', { key: 'matrix', className: 'mdisp-card' }, [
          React.createElement('div', { key: 't', className: 'mdisp-title' }, '任务类型 × 难度 → 模型'),
          React.createElement('table', { key: 'tab', className: 'mdisp-table' }, [
            React.createElement('thead', { key: 'h' }, React.createElement('tr', { key: 'r' }, [
              React.createElement('th', { key: 't' }, '任务类型'),
              React.createElement('th', { key: 'h' }, '高难度'),
              React.createElement('th', { key: 'm' }, '中难度'),
              React.createElement('th', { key: 'l' }, '低难度'),
              React.createElement('th', { key: 'x' }, ''),
            ])),
            React.createElement('tbody', { key: 'b' }, tableRows),
          ]),
          React.createElement('div', { key: 'add', className: 'mdisp-row' }, [
            React.createElement('input', { key: 'i', className: 'mdisp-input', placeholder: '自定义任务类型（如 database）', value: newType, onChange: function (ev) { setNewType(ev.target.value); } }),
            React.createElement('button', { key: 'b', className: 'mdisp-btn', onClick: addType }, '添加类型'),
          ]),
        ]),

        React.createElement('div', { key: 'diagcard', className: 'mdisp-card' }, [
          React.createElement('div', { key: 't', className: 'mdisp-title' }, '模型目录（' + catalog.length + ' 个 provider / ' + modelCount + ' 个模型）'),
          React.createElement('div', { key: 'c', className: 'mdisp-muted' }, '下拉里若看不到已录入模型，点「刷新目录」，下面的诊断会说明每个来源拿到了什么。'),
          React.createElement('ul', { key: 'l', className: 'mdisp-diag' }, diagnostics.map(function (d, i) {
            return React.createElement('li', { key: 'dg' + i }, d);
          })),
          React.createElement('button', { key: 'b', className: 'mdisp-btn', onClick: reload }, '刷新目录'),
        ]),

        React.createElement('div', { key: 'foot', className: 'mdisp-row' }, [
          React.createElement('button', { key: 's', className: 'mdisp-btn', onClick: save }, '保存配置'),
          React.createElement('span', { key: 'st', className: 'mdisp-status' }, status),
        ]),
      ]);
    }

    function TYPE_LABEL(t) {
      var labels = { architecture: '（架构设计）', coding: '（编码）', 'ui-design': '（UI）', bugfix: '（纠错）', review: '（评审）', docs: '（文档）', testing: '（测试）', research: '（调研）' };
      return labels[t] || '';
    }

    // ---------- 运行卡面板 ----------
    function RunPanel() {
      var st = React.useState(null);
      var state = st[0], setState = st[1];
      React.useEffect(function () {
        var alive = true;
        fetch('/api/mdisp/state').then(function (r) { return r.json() }).then(function (v) { if (alive) setState(v); }).catch(function () {});
        return function () { alive = false; };
      }, []);

      if (!state) return React.createElement('div', { className: 'mdisp-muted' }, '模型分工：加载中…');
      var cfg = state.config || {};
      var routeCount = Array.isArray(cfg.routes) ? cfg.routes.length : 0;
      return React.createElement('div', { className: 'mdisp-wrap' }, [
        React.createElement('div', { key: 't', className: 'mdisp-title' }, '模型分工（Model Dispatch）'),
        React.createElement('div', { key: 'a', className: 'mdisp-muted' }, '评估任务类型与难度并派发给不同模型；独立任务并行执行、重复任务合并、歧义任务先向用户确认。'),
        React.createElement('div', { key: 'b' }, '全局默认：' + (cfg.enabled ? '开启' : '关闭') + ' · 定点路由 ' + routeCount + ' 条 · 最大并行 ' + (cfg.maxParallel || 4) + ' · 澄清提问 ' + (cfg.askWhenAmbiguous ? '开' : '关')),
        React.createElement('div', { key: 'c', className: 'mdisp-muted' }, '本会话开关：/mdisp on · /mdisp off；模型矩阵在 设置 → 模型分工 配置。主代理在模式开启时会通过 dispatch_task 工具派发任务。'),
        React.createElement('button', { key: 'd', className: 'mdisp-btn', onClick: function () {
          fetch('/api/mdisp/state').then(function (r) { return r.json() }).then(function (v) { setState(v); }).catch(function () {});
        } }, '刷新'),
      ]);
    }

    // ---------- 输入框工具栏的「模式」药丸（conversation.input.left） ----------
    function chipSessionId(props) {
      try {
        if (!props) return undefined;
        function pick(v) {
          if (!v) return undefined;
          if (typeof v === 'string') return v;
          if (typeof v === 'object') {
            if (typeof v.id === 'string') return v.id;
            if (typeof v.sessionId === 'string') return v.sessionId;
            if (v.session && typeof v.session.id === 'string') return v.session.id;
          }
          return undefined;
        }
        return pick(props.session) || pick(props.sessionId) || pick(props.conversation) || undefined;
      } catch (err) {
        return undefined;
      }
    }

    function ModeChip(props) {
      var st = React.useState(null);
      var mode = st[0], setMode = st[1];
      var bt = React.useState(false);
      var busy = bt[0], setBusy = bt[1];
      var sid = chipSessionId(props);

      function load() {
        var url = sid ? '/api/mdisp/state?sessionId=' + encodeURIComponent(sid) : '/api/mdisp/state';
        return fetch(url).then(function (r) { return r.json() }).then(function (v) {
          setMode(!!(v && v.mode));
        }).catch(function () { setMode(null); });
      }

      React.useEffect(function () {
        var alive = true;
        var url = sid ? '/api/mdisp/state?sessionId=' + encodeURIComponent(sid) : '/api/mdisp/state';
        fetch(url).then(function (r) { return r.json() }).then(function (v) {
          if (alive) setMode(!!(v && v.mode));
        }).catch(function () { if (alive) setMode(null); });
        return function () { alive = false; };
      }, [sid]);

      if (mode === null) return null;

      function toggle() {
        setBusy(true);
        var next = !mode;
        var body = sid ? { sessionId: sid, active: next } : { enabled: next };
        var path = sid ? '/api/mdisp/set-mode' : '/api/mdisp/set-enabled';
        fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(function (r) { return r.json() }).then(function () { setMode(next); })
          .catch(function () { return load(); })
          .then(function () { setBusy(false); });
      }

      var title = sid
        ? '模型分工模式（本会话）：点击' + (mode ? '关闭' : '开启') + '；也可用 /mdisp on|off'
        : '模型分工模式（全局）：点击' + (mode ? '关闭' : '开启') + '，对所有会话生效；单会话精确开关请用 /mdisp on|off';
      return React.createElement('button', {
        type: 'button',
        className: 'mdisp-chip' + (mode ? ' on' : ''),
        disabled: busy,
        title: title,
        onClick: toggle,
      }, '分工' + (mode ? ' 开' : ' 关'));
    }

    // ---------- 插件体：apply(ctx, config) ----------
    function apply(ctx, config) {
      // ---------- 样式注入（走宿主 styles 机制，不直接操作 DOM） ----------
      if (ctx.styles && typeof ctx.styles.insert === 'function') {
        ctx.styles.insert(
          '.mdisp-wrap{display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--dsw-alias-label-primary,#e8e8ee);}' +
          '.mdisp-card{background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;}' +
          '.mdisp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}' +
          '.mdisp-title{font-weight:600;font-size:14px;color:var(--dsw-alias-label-primary,#e8e8ee);}' +
          '.mdisp-muted{color:var(--dsw-alias-label-secondary,#a8a8b3);font-size:12px;line-height:1.5;}' +
          '.mdisp-table{width:100%;border-collapse:collapse;font-size:13px;}' +
          '.mdisp-table th{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e8e8ee);}' +
          '.mdisp-table th,.mdisp-table td{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.28));padding:5px 8px;text-align:left;}' +
          '.mdisp-select,.mdisp-input{background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-2,#2a2a33));color:var(--dsw-alias-label-primary,#e8e8ee);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:6px;padding:4px 6px;font-size:12.5px;max-width:230px;}' +
          '.mdisp-select option,.mdisp-select optgroup{background-color:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2,#2a2a33));color:var(--dsw-alias-label-primary,#e8e8ee);}' +
          '.mdisp-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:8px;padding:5px 14px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e8e8ee);font-size:12.5px;}' +
          '.mdisp-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22));}' +
          '.mdisp-status{font-size:12px;color:var(--dsw-alias-label-secondary,#a8a8b3);}' +
          '.mdisp-diag{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary,#a8a8b3);font-size:11.5px;line-height:1.6;}' +
          '.mdisp-chip{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.45));border-radius:999px;padding:3px 10px;font-size:12px;line-height:1.4;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#a8a8b3);}' +
          '.mdisp-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.22));}' +
          '.mdisp-chip.on{background:var(--dsw-alias-brand-primary,#3b82f6);color:var(--dsw-alias-brand-text,#fff);border-color:transparent;}' +
          '.mdisp-chip[disabled]{opacity:.6;cursor:default;}'
        );
      }

      // ---------- Slot 注册 ----------
      var slots = ctx.get('slots');
      if (slots === undefined) return;
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'model-dispatch', order: 60, label: '模型分工' },
          function () { return React.createElement(SettingsPage); }
        );
      });

      slots.inject('tool.view.cordis', function () {
        return slots.register(
          { name: 'tool.view.cordis', key: 'self' },
          function (props) { return React.createElement(RunPanel, props); }
        );
      });

      slots.inject('conversation.input.left', function () {
        return slots.register(
          { name: 'conversation.input.left', id: 'model-dispatch', order: 50, label: '模型分工' },
          function (props) { return React.createElement(ModeChip, props); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  },
});

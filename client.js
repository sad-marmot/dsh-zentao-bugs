/**
 * Client half of the ZenTao bug query plugin.
 *
 * Registers:
 *  - `sidebar.panellist` : the "禅道" icon in the left sidebar start panel.
 *  - `main` (keyed)      : the ZenTao bug list / detail page in the main panel.
 *  - `sidebarRightTabs`  : a "禅道" tab type + guide entry, so the same page
 *                          can also open in the right sidebar (开始页 → 禅道).
 *  - `settings.section`  : 设置 → 禅道 (address / username / password).
 *
 * Data comes from the same-origin proxy `/zentao-plugin/*` served by the
 * Host half, so the browser holds no ZenTao credentials.
 */
window.__ModuleLoader__.load({
  id: 'dsh-zentao-bugs',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState, useSyncExternalStore } = React;

    /** The plugin's settings form, assigned during apply(); panels read the
     *  credential snapshot from it to react to changes (incl. clearing). */
    let settingsForm = null;

    const SEVERITY = {
      1: { label: 'S1', color: '#dc2626' },
      2: { label: 'S2', color: '#ea580c' },
      3: { label: 'S3', color: '#2563eb' },
      4: { label: 'S4', color: '#6b7280' },
    };
    const PRI = {
      1: { label: 'P1', color: '#dc2626' },
      2: { label: 'P2', color: '#ea580c' },
      3: { label: 'P3', color: '#2563eb' },
      4: { label: 'P4', color: '#6b7280' },
    };
    const STATUS = {
      active: { label: '激活', color: '#dc2626' },
      resolved: { label: '已解决', color: '#16a34a' },
      closed: { label: '已关闭', color: '#6b7280' },
    };
    const ACTION_LABEL = {
      opened: '创建', assigned: '指派', resolved: '解决', closed: '关闭',
      activated: '激活', edited: '编辑', comment: '评论', confirmed: '确认',
      assignto: '指派', started: '开始', finished: '完成', paused: '暂停',
      cancelled: '取消', mailto: '抄送', plan: '计划',
    };

    function badge(text, color) {
      return h('span', {
        style: {
          display: 'inline-block', padding: '1px 8px', borderRadius: 999,
          fontSize: 11, lineHeight: '18px', whiteSpace: 'nowrap',
          color, background: 'color-mix(in srgb, ' + color + ' 14%, transparent)',
          border: '1px solid color-mix(in srgb, ' + color + ' 35%, transparent)',
        },
      }, text);
    }

    /** Same artwork as icon.svg; themed by currentColor. */
    const ZENTAO_ICON_PATH = 'M90.52467136 370.1611846S107.57730298 90.125 383.88322351 90.125c248.9950654 0 269.46710513 208.27302649 375.24671109 280.0361846 102.31578974 75.40460513 136.42105298 3.59703973 160.3125-86.15131622 0 0 57.99671027 219.01973676-54.62171109 226.21381622-112.52960513 7.14967136-197.79276325-46.71710513-266.00328891-86.15131622-71.67434189-35.97039487-252.45888162-28.7763154-293.40296109 111.28618459-40.89967136 140.01809189 10.2138154 254.9013154 160.3125 254.90131541s160.3125-71.8075654 160.3125-111.28618378c0-39.52302649-40.89967136-86.19572351-105.69078891-86.19572433-64.83552649 0-68.2549346 104.13651324-27.31085596 140.01809271 0 0-81.84375 14.38815811-81.84375-140.01809271 0-118.48026324 146.67927649-111.2861846 187.57894785-111.28618378 40.94407864 0 187.62335513 46.62828974 187.62335513 226.16940811 0 175.94407864-231.9424346 226.2138154-320.625 226.2138154-88.72697351 0-337.72203974-53.86677649-375.24671026-280.0361846 0 0 37.52467136 82.5986846 105.73519702 57.41940811 68.2549346-25.13486838 0-100.53947351 0-168.75s40.94407864-150.80921026 81.88815811-168.75c40.94407864-17.94078973 61.41611838-100.53947351 0-111.28618377C216.73190811 244.53125 121.21052649 294.80098676 90.52467136 370.1611846z';

    function ZenTaoGlyph({ size }) {
      return h('svg', {
        viewBox: '0 0 1024 1024', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block' },
      }, h('path', { fill: 'currentColor', d: ZENTAO_ICON_PATH }));
    }

    /** ----------------------------------------------------------------
     * Left sidebar start-panel icon row. The sidebar passes `size`
     * (16 expanded / 18 collapsed), so the glyph keeps the built-in
     * icons' box and the label stays aligned.
     */
    function ZenTaoIcon({ size = 16 }) {
      return h(ZenTaoGlyph, { size });
    }

    /** ----------------------------------------------------------------
     * Bug list view (paged) and detail view.
     */
    function ZenTaoPanel() {
      const [view, setView] = useState('list');
      const [list, setList] = useState(null);
      const [error, setError] = useState('');
      const [page, setPage] = useState(1);
      const [pageSize, setPageSize] = useState(20);
      const [detail, setDetail] = useState(null);
      const [detailLoading, setDetailLoading] = useState(false);

      const loadList = useCallback(async () => {
        setError('');
        setList(null);
        try {
          const res = await fetch('/zentao-plugin/bugs');
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
          setList(body);
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }, []);

      useEffect(() => { loadList(); }, [loadList]);

      // 凭据/地址变化（含清空配置）时自动重新拉取：
      // 清空后面板立即转为报错状态，不再显示旧数据。
      const credSnap = useSyncExternalStore(
        (cb) => settingsForm.subscribe(cb),
        () => settingsForm.getSnapshot(),
        () => settingsForm.getSnapshot(),
      );
      const credKey = [
        credSnap && credSnap.value && credSnap.value.baseUrl,
        credSnap && credSnap.value && credSnap.value.username,
        credSnap && credSnap.value && credSnap.value.password,
      ].map((v) => (v ? '1' : '0')).join('');
      useEffect(() => { loadList(); }, [credKey, loadList]);

      const openDetail = useCallback(async (id) => {
        setView('detail');
        setDetail(null);
        setDetailLoading(true);
        setError('');
        try {
          const res = await fetch('/zentao-plugin/bug/' + id);
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
          setDetail(body);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setDetailLoading(false);
        }
      }, []);

      if (view === 'detail') {
        return h(DetailView, { detail, loading: detailLoading, error, onBack: () => setView('list') });
      }
      return h(ListView, { list, error, page, setPage, pageSize, setPageSize, openDetail, onRefresh: loadList });
    }

    function ListView({ list, error, page, setPage, pageSize, setPageSize, openDetail, onRefresh }) {
      const bugs = (list && list.bugs) || [];
      const totalPages = Math.max(1, Math.ceil(bugs.length / pageSize));
      const current = Math.min(page, totalPages);
      const rows = bugs.slice((current - 1) * pageSize, current * pageSize);

      const th = { textAlign: 'left', padding: '6px 10px', fontSize: 12, opacity: 0.65, fontWeight: 500, borderBottom: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.3))', whiteSpace: 'nowrap' };
      const td = { padding: '7px 10px', fontSize: 13, borderBottom: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.18))', verticalAlign: 'top' };
      const pageBtn = (disabled) => ({ all: 'unset', cursor: disabled ? 'default' : 'pointer', fontSize: 13, opacity: disabled ? 0.35 : 0.85 });
      const selectStyle = { padding: '2px 6px', borderRadius: 6, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', fontSize: 12 };

      return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', padding: '16px 20px', boxSizing: 'border-box' } },
        // ── 固定头部 ──
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flex: '0 0 auto' } },
          h('h1', { style: { fontSize: 17, fontWeight: 600, margin: 0 } }, '禅道 · 指派给我的 Bug'),
          list ? h('span', { style: { fontSize: 12, opacity: 0.55 } }, '共 ' + list.total + ' 条') : null,
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button', onClick: onRefresh,
            style: { all: 'unset', cursor: 'pointer', fontSize: 12, opacity: 0.7 },
          }, '刷新'),
        ),
        error ? h('div', { style: { color: '#e05666', fontSize: 13, margin: '8px 0', flex: '0 0 auto' } }, '加载失败：' + error) : null,
        // ── 列表：占满剩余空间，空间不够时内部滚动 ──
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
          h('table', { style: { width: '100%', borderCollapse: 'collapse' } },
            h('thead', null, h('tr', null,
              h('th', { style: { ...th, position: 'sticky', top: 0, background: 'var(--dsw-alias-panel, var(--dsw-specific-panel, inherit))' } }, 'ID'),
              h('th', { style: { ...th, position: 'sticky', top: 0 } }, '严重程度'),
              h('th', { style: { ...th, position: 'sticky', top: 0 } }, '优先级'),
              h('th', { style: { ...th, position: 'sticky', top: 0 } }, '状态'),
              h('th', { style: { ...th, width: '45%', position: 'sticky', top: 0 } }, '标题'),
              h('th', { style: { ...th, position: 'sticky', top: 0 } }, '产品'),
              h('th', { style: { ...th, position: 'sticky', top: 0 } }, ''),
            )),
            h('tbody', null, rows.map((b) => {
              const sev = SEVERITY[b.severity] || SEVERITY[4];
              const pri = PRI[b.pri] || PRI[4];
              const st = STATUS[b.status] || { label: b.status, color: '#6b7280' };
              return h('tr', { key: b.id },
                h('td', { style: { ...td, fontFamily: 'monospace', whiteSpace: 'nowrap' } }, '#' + b.id),
                h('td', { style: td }, badge(sev.label, sev.color)),
                h('td', { style: td }, badge(pri.label, pri.color)),
                h('td', { style: td }, badge(st.label, st.color)),
                h('td', { style: td },
                  h('a', {
                    href: (list && list.webBase ? list.webBase : '') + '/bug-view-' + b.id + '.html',
                    target: '_blank', rel: 'noreferrer',
                    title: '在面板中查看详情',
                    style: { color: 'inherit', textDecoration: 'none', cursor: 'pointer' },
                    onClick: (e) => { e.preventDefault(); openDetail(b.id); },
                  }, b.title),
                ),
                h('td', { style: { ...td, opacity: 0.8, whiteSpace: 'nowrap' } }, b.productName),
                h('td', { style: td },
                  h('button', {
                    type: 'button',
                    title: '在系统浏览器中打开该 Bug',
                    onClick: () => window.open((list && list.webBase ? list.webBase : '') + '/bug-view-' + b.id + '.html', '_blank'),
                    style: {
                      all: 'unset', cursor: 'pointer', fontSize: 12,
                      color: 'var(--dsw-alias-link, #3b82f6)', whiteSpace: 'nowrap',
                    },
                  }, '详情'),
                ),
              );
            })),
          ),
          !list && !error ? h('div', { style: { padding: '20px 0', opacity: 0.55, fontSize: 13 } }, '加载中…') : null,
          list && bugs.length === 0 ? h('div', { style: { padding: '20px 0', opacity: 0.55, fontSize: 13 } }, '没有指派给你的未关闭 Bug。') : null,
        ),
        // ── 固定底部分页条 ──
        h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 14, paddingTop: 10, marginTop: 2, borderTop: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.25))' } },
          h('span', { style: { fontSize: 12, opacity: 0.65 } }, '共 ' + bugs.length + ' 条'),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button', disabled: current <= 1, onClick: () => setPage(current - 1),
            style: pageBtn(current <= 1),
          }, '‹ 上一页'),
          h('span', { style: { fontSize: 12, opacity: 0.65, whiteSpace: 'nowrap' } }, current + ' / ' + totalPages),
          h('button', {
            type: 'button', disabled: current >= totalPages, onClick: () => setPage(current + 1),
            style: pageBtn(current >= totalPages),
          }, '下一页 ›'),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, opacity: 0.75 } },
            '每页',
            h('select', {
              value: pageSize,
              onChange: (e) => { setPageSize(Number(e.target.value) || 20); setPage(1); },
              style: selectStyle,
            }, [20, 50, 100].map((n) => h('option', { value: n, key: n }, n))),
            '条'),
        ),
      );
    }

    function DetailView({ detail, loading, error, onBack }) {
      if (loading) return h('div', { style: { padding: '16px 20px', fontSize: 13, opacity: 0.6 } }, '加载详情中…');
      if (error) return h('div', { style: { padding: '16px 20px' } },
        h('button', { type: 'button', onClick: onBack, style: { all: 'unset', cursor: 'pointer', fontSize: 13, opacity: 0.7 } }, '‹ 返回列表'),
        h('div', { style: { color: '#e05666', fontSize: 13, marginTop: 10 } }, '加载失败：' + error),
      );
      if (!detail) return null;
      const b = detail.bug;
      const st = STATUS[b.status] || { label: b.status, color: '#6b7280' };
      const sev = SEVERITY[b.severity] || SEVERITY[4];

      const field = (label, value) => h('div', { style: { display: 'flex', gap: 8, fontSize: 13, lineHeight: 1.7 } },
        h('span', { style: { opacity: 0.55, flex: '0 0 84px' } }, label),
        h('span', { style: { minWidth: 0, wordBreak: 'break-word' } }, value || '—'),
      );

      return h('div', { style: { height: '100%', overflowY: 'auto', padding: '16px 20px', boxSizing: 'border-box' } },
        h('button', { type: 'button', onClick: onBack, style: { all: 'unset', cursor: 'pointer', fontSize: 13, opacity: 0.7, marginBottom: 10, display: 'block' } }, '‹ 返回列表'),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 } },
          h('span', { style: { fontFamily: 'monospace', fontSize: 15, fontWeight: 600 } }, '#' + b.id),
          h('span', { style: { fontSize: 15, fontWeight: 600 } }, b.title),
          badge(st.label, st.color),
          badge(sev.label, sev.color),
          h('span', { style: { flex: 1 } }),
          h('a', {
            href: b.webUrl, target: '_blank', rel: 'noreferrer',
            onClick: (e) => { e.preventDefault(); window.open(b.webUrl, '_blank'); },
            style: { fontSize: 12, cursor: 'pointer' },
          }, '在浏览器打开 ↗'),
        ),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '2px 24px', margin: '8px 0 14px' } },
          field('产品', b.productName),
          field('所属模块', b.module),
          field('类型', b.type),
          field('优先级', 'P' + b.pri),
          field('创建人', b.openedBy + (b.openedDate ? ' · ' + b.openedDate : '')),
          field('当前指派', b.assignedTo + (b.assignedDate ? ' · ' + b.assignedDate : '')),
          field('解决者', b.resolvedBy ? b.resolvedBy + (b.resolvedDate ? ' · ' + b.resolvedDate : '') + (b.resolution ? '（' + b.resolution + '）' : '') : ''),
          field('截止日期', b.deadline),
        ),
        h('div', { style: { fontSize: 13, fontWeight: 600, margin: '4px 0 6px' } }, '重现步骤'),
        h('div', {
          className: 'zentao-bugs-steps',
          style: { fontSize: 13, lineHeight: 1.65, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.25))', borderRadius: 8, padding: '10px 12px', wordBreak: 'break-word' },
          dangerouslySetInnerHTML: { __html: b.steps || '（无）' },
        }),
        h('div', { style: { fontSize: 13, fontWeight: 600, margin: '16px 0 6px' } }, '历史记录与评论'),
        (detail.actions || []).length === 0
          ? h('div', { style: { fontSize: 13, opacity: 0.55 } }, '暂无记录。')
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, detail.actions.map((a) =>
              h('div', { key: a.id, style: { border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.2))', borderRadius: 8, padding: '8px 12px', fontSize: 13 } },
                h('div', { style: { opacity: 0.7, fontSize: 12, marginBottom: a.comment || a.history.length ? 4 : 0 } },
                  (ACTION_LABEL[a.action] || a.action) + ' · ' + a.actor + ' · ' + a.date),
                a.history.length ? h('div', { style: { fontSize: 12, opacity: 0.8, marginBottom: a.comment ? 4 : 0 } },
                  a.history.map((hi, i) => h('div', { key: i }, hi.field + '：' + hi.old + ' → ' + hi.new))) : null,
                a.comment ? h('div', {
                  className: 'zentao-bugs-steps',
                  style: { lineHeight: 1.6, wordBreak: 'break-word' },
                  dangerouslySetInnerHTML: { __html: a.comment },
                }) : null,
              )),
            ),
      );
    }

    /** ----------------------------------------------------------------
     * Settings section (设置 → 禅道).
     */

    /** Accessible switch control (role="switch"), themed by tokens. */
    function Switch({ checked, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': !!checked,
        'aria-label': label,
        onClick: () => onChange(!checked),
        style: {
          all: 'unset', cursor: 'pointer', position: 'relative', flex: '0 0 36px',
          width: 36, height: 20, borderRadius: 999, boxSizing: 'border-box',
          background: checked
            ? 'var(--dsw-alias-state-business-primary, #3b82f6)'
            : 'var(--dsw-alias-border, rgba(128,128,128,0.45))',
          transition: 'background 0.15s ease',
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute', top: 2, left: 2, width: 16, height: 16,
          borderRadius: '50%', background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
          transform: checked ? 'translateX(16px)' : 'translateX(0)',
          transition: 'transform 0.15s ease',
        },
      }));
    }

    function SettingsSection({ ctx, form }) {
      // 订阅设置快照：写入被接受后面板自动重渲染，开关状态才不会弹回。
      const snap = useSyncExternalStore(
        (cb) => form.subscribe(cb),
        () => form.getSnapshot(),
        () => form.getSnapshot(),
      );
      const value = (snap && snap.value) || {};
      const [saved, setSaved] = useState(null);
      const [confirmClear, setConfirmClear] = useState(false);
      // 输入框为受控组件：草稿跟随用户输入，配置被清空时重置为空。
      const [drafts, setDrafts] = useState({});
      const draftOf = (field) => drafts[field] !== undefined ? drafts[field] : (value[field] || '');
      const setDraft = (field, v) => setDrafts((d) => ({ ...d, [field]: v }));

      const inputStyle = { padding: '5px 9px', borderRadius: 6, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.35))', background: 'transparent', color: 'inherit', minWidth: 0, flex: 1, fontSize: 13 };
      const rowStyle = { display: 'flex', gap: 10, alignItems: 'center', maxWidth: 560 };
      const labelStyle = { fontSize: 12, opacity: 0.75, flex: '0 0 96px' };
      const btnStyle = { all: 'unset', cursor: 'pointer', fontSize: 13, padding: '6px 16px', borderRadius: 8, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.35))' };

      const save = async (field, v) => {
        try {
          const ops = [{ op: 'set', path: [field], value: v }];
          const resp = await ctx.remote.settings.mutate('zentao-bugs', ops, snap.revision);
          setSaved({ ok: !!resp.ok, msg: resp.ok ? '已保存。' : ('保存被拒: ' + ((resp.error && resp.error.message) || JSON.stringify(resp.error))) });
        } catch (err) {
          setSaved({ ok: false, msg: '保存异常: ' + String((err && err.message) || err) });
        }
        setTimeout(() => setSaved(null), 8000);
      };

      const clearConfig = async () => {
        setConfirmClear(false);
        try {
          const resp = await ctx.remote.settings.mutate('zentao-bugs', [
            { op: 'unset', path: ['baseUrl'] },
            { op: 'unset', path: ['username'] },
            { op: 'unset', path: ['password'] },
          ], snap.revision);
          if (resp.ok) setDrafts({});
          setSaved({ ok: !!resp.ok, msg: resp.ok ? '配置已清空。请重新填写禅道地址、用户名和密码。' : ('清空被拒: ' + ((resp.error && resp.error.message) || JSON.stringify(resp.error))) });
        } catch (err) {
          setSaved({ ok: false, msg: '清空异常: ' + String((err && err.message) || err) });
        }
        setTimeout(() => setSaved(null), 8000);
      };

      const switchRow = (label, field, text) => h('div', { style: rowStyle },
        h('label', { style: labelStyle }, label),
        h(Switch, {
          checked: value[field] !== false,
          onChange: (v) => save(field, v),
          label: text,
        }),
        h('span', { style: { fontSize: 13 } }, text),
      );

      return h('div', { style: { position: 'relative', padding: '4px 2px', maxWidth: 640, height: '100%', overflowY: 'auto', boxSizing: 'border-box' } },
        h('h2', { style: { fontSize: 16, fontWeight: 600, margin: '0 0 4px' } }, '禅道'),
        h('div', { style: { fontSize: 12, opacity: 0.65, marginBottom: 14 } },
          '配置禅道内网地址和账号。凭据保存在本机配置文件中（明文），仅用于本机向禅道发起查询。'),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('div', { style: rowStyle },
            h('label', { style: labelStyle }, '禅道地址'),
            h('input', {
              style: inputStyle, value: draftOf('baseUrl'),
              placeholder: 'http://zentao.example.com/zentao',
              onChange: (e) => setDraft('baseUrl', e.target.value),
              onBlur: (e) => { const v = e.target.value.trim(); if (v !== (value.baseUrl || '')) save('baseUrl', v); },
            }),
          ),
          h('div', { style: rowStyle },
            h('label', { style: labelStyle }, '用户名'),
            h('input', {
              style: inputStyle, value: draftOf('username'),
              onChange: (e) => setDraft('username', e.target.value),
              onBlur: (e) => { const v = e.target.value.trim(); if (v !== (value.username || '')) save('username', v); },
            }),
          ),
          h('div', { style: rowStyle },
            h('label', { style: labelStyle }, '密码'),
            h('input', {
              type: 'password', style: inputStyle, value: draftOf('password'),
              placeholder: '输入后点击其他位置保存',
              onChange: (e) => setDraft('password', e.target.value),
              onBlur: (e) => { if (e.target.value !== (value.password || '')) save('password', e.target.value); },
            }),
          ),
          h('div', { style: { display: 'flex', justifyContent: 'flex-start' } },
            h('button', {
              type: 'button',
              onClick: () => setConfirmClear(true),
              disabled: !(value.baseUrl || value.username || value.password),
              title: '清空禅道地址、用户名和密码',
              style: { all: 'unset', cursor: !(value.baseUrl || value.username || value.password) ? 'default' : 'pointer', fontSize: 12, color: '#e05666', opacity: (value.baseUrl || value.username || value.password) ? 0.9 : 0.4 },
            }, '清空配置'),
          ),
          switchRow('左侧边栏', 'showLeftSidebar', '在左侧边栏展示入口'),
          switchRow('右侧边栏', 'showRightSidebar', '在右侧边栏展示入口'),
        ),
        h('div', { style: { fontSize: 12, opacity: 0.55, marginTop: 10, height: 16 } },
          saved ? (saved.ok ? saved.msg : h('span', { style: { color: '#e05666' } }, saved.msg)) : '修改后自动保存；开关即时生效。'),
        confirmClear ? h('div', {
          onClick: (e) => { if (e.target === e.currentTarget) setConfirmClear(false); },
          style: { position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 10 },
        },
          h('div', {
            role: 'dialog', 'aria-modal': true, 'aria-label': '清空配置',
            style: {
              background: 'var(--dsw-alias-button-elevated-fill, #2b2b30)', color: 'inherit',
              borderRadius: 10, padding: '18px 20px', maxWidth: 380, width: '86%',
              border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.3))',
              boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            },
          },
            h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 8 } }, '清空配置'),
            h('div', { style: { fontSize: 13, lineHeight: 1.6, marginBottom: 16, opacity: 0.85 } },
              '将清空禅道地址、用户名和密码，禅道面板将无法查询数据；重新填写后才能恢复使用。确定要清空吗？'),
            h('div', { style: { display: 'flex', gap: 10, justifyContent: 'flex-end' } },
              h('button', { type: 'button', style: btnStyle, onClick: () => setConfirmClear(false) }, '取消'),
              h('button', {
                type: 'button', onClick: clearConfig,
                style: { ...btnStyle, background: '#dc2626', borderColor: '#dc2626', color: '#fff' },
              }, '确认清空'),
            ),
          ),
        ) : null,
      );
    }

    /** ----------------------------------------------------------------
     * Registration.
     */
    const TAB_KIND = 'zentao-bugs';

    /** Entry visibility from the accepted settings snapshot (default: both on). */
    function entryFlags(form) {
      const snap = form.getSnapshot();
      const v = (snap && snap.value) || {};
      return { left: v.showLeftSidebar !== false, right: v.showRightSidebar !== false };
    }

    /** (Re)register the entries that are currently enabled; returns a disposer. */
    function registerEntries(ctx, form, flags) {
      const disposers = [];
      if (flags.left) {
        // 开始界面（面板列表）中的"禅道"入口 + 主面板页面（列表 + 详情）。
        disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'zentao-bugs',
          order: 40,
          label: '禅道',
        }, ZenTaoIcon)));
        disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          id: 'zentao-bugs-main',
          key: 'zentao-bugs',
        }, ZenTaoPanel)));
      }
      if (flags.right) {
        // 右侧栏：注册页类型；带 guide 入口即出现在右侧栏"开始"页，
        // 点击胶囊在该格打开（默认自动替换引导页）。
        disposers.push(ctx.effect(() => ctx.sidebarRightTabs.register({
          id: 'dsh-zentao-bugs',
          kind: TAB_KIND,
          title: () => '禅道',
          keepMounted: true,
          guide: [{
            id: 'zentao-bugs',
            kind: TAB_KIND,
            title: () => '禅道',
            description: () => '指派给我的禅道 Bug',
            order: 50,
            icon: ZenTaoGlyph,
          }],
        }), 'zentao-bugs: right sidebar tab type'));
        // 右侧栏页面正文：与主面板同一套列表/详情组件。
        disposers.push(ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: 'dsh-zentao-bugs',
        }, ZenTaoPanel)), 'zentao-bugs: right sidebar pane'));
      }
      return () => disposers.forEach((d) => { try { d(); } catch { /* already gone */ } });
    }

    return {
      inject: ['slots', 'configForms', 'sidebarRightTabs', 'remote', 'remote.settings'],
      apply(ctx) {
        const form = ctx.configForms.get('zentao-bugs');
        settingsForm = form;

        // 两个入口跟随设置开关，配置变化时先注销再按需重注册。
        ctx.effect(() => {
          let last = null;
          let cleanup = null;
          const sync = () => {
            const flags = entryFlags(form);
            const key = (flags.left ? 'L' : '-') + (flags.right ? 'R' : '-');
            if (key === last) return;
            last = key;
            if (cleanup) cleanup();
            cleanup = registerEntries(ctx, form, flags);
          };
          sync();
          const unsub = form.subscribe(sync);
          return () => { unsub(); if (cleanup) cleanup(); cleanup = null; };
        }, 'zentao-bugs: entry toggles');

        // 设置界面中的"禅道"分区。
        function SettingsSectionBound() {
          return h(SettingsSection, { ctx, form });
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'zentao-bugs',
          order: 901,
          label: '禅道',
        }, SettingsSectionBound));
      },
    };
  },
});

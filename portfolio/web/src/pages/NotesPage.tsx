import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";

interface Note {
  id: number;
  title: string;
  content: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Draft {
  id: number | null; // null = 新建
  title: string;
  content: string;
  pinned: boolean;
}

/** 行内加粗：**text** */
function renderInline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <b key={i}>{part.slice(2, -2)}</b> : part,
  );
}

/** 轻量 Markdown 渲染：## 标题、- 列表、1. 有序列表、| 表格、**加粗**，其余按段落。 */
function renderMarkdown(src: string): ReactNode[] {
  const lines = src.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    if (trimmed.startsWith("## ")) {
      out.push(<h4 key={key++} className="note-h">{renderInline(trimmed.slice(3))}</h4>);
      i++;
    } else if (trimmed.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^[-: ]*$/.test(c))) rows.push(cells); // 跳过分隔行
        i++;
      }
      if (rows.length > 0) {
        out.push(
          <table key={key++} className="note-table">
            <thead><tr>{rows[0].map((c, j) => <th key={j}>{renderInline(c)}</th>)}</tr></thead>
            <tbody>{rows.slice(1).map((row, r) => <tr key={r}>{row.map((c, j) => <td key={j}>{renderInline(c)}</td>)}</tr>)}</tbody>
          </table>,
        );
      }
    } else if (trimmed.startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      out.push(<ul key={key++} className="note-list">{items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ul>);
    } else if (/^\d+\.\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s/, ""));
        i++;
      }
      out.push(<ol key={key++} className="note-list">{items.map((item, j) => <li key={j}>{renderInline(item)}</li>)}</ol>);
    } else {
      out.push(<p key={key++} className="note-p">{renderInline(trimmed)}</p>);
      i++;
    }
  }
  return out;
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null); // 默认全部折叠

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setNotes(await api.get<Note[]>("/api/notes"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "笔记加载失败");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const body = { title: draft.title, content: draft.content, pinned: draft.pinned };
      if (draft.id == null) {
        await api.post("/api/notes", body);
      } else {
        await api.put(`/api/notes/${draft.id}`, body);
      }
      setNotice(draft.id == null ? "笔记已创建" : "笔记已保存");
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "笔记保存失败");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (note: Note) => {
    if (!window.confirm(`确定删除笔记「${note.title}」？此操作不可恢复。`)) return;
    try {
      await api.delete(`/api/notes/${note.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const togglePin = async (note: Note) => {
    try {
      await api.put(`/api/notes/${note.id}`, { title: note.title, content: note.content, pinned: !note.pinned });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "置顶操作失败");
    }
  };

  if (busy) return <div className="empty"><span className="spin dark" aria-label="正在加载笔记" /></div>;

  return (
    <div className="fade-in">
      <div className="page-heading-row">
        <div>
          <h1 className="page-title">个人笔记本</h1>
          <p className="page-desc">记录投资决策、复盘结论和行动清单；点击标题展开详情。</p>
        </div>
        <button className="btn" onClick={() => setDraft({ id: null, title: "", content: "", pinned: false })}>新建笔记</button>
      </div>

      {error && <div className="alert error" role="alert">{error}</div>}
      {notice && <div className="alert ok" role="status">{notice}</div>}

      {draft && (
        <section className="card section-card" aria-label="编辑笔记">
          <div className="card-h">{draft.id == null ? "新建笔记" : "编辑笔记"}</div>
          <div className="field">
            <label htmlFor="note-title">标题</label>
            <input id="note-title" className="input" value={draft.title} autoFocus
              onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="note-content">内容</label>
            <textarea id="note-content" className="input note-editor" rows={14} value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
            <p className="helper-text">支持轻量格式：<code>## 小节标题</code> · <code>- 列表</code> · <code>1. 有序列表</code> · <code>**加粗**</code> · <code>| 表格 |</code></p>
          </div>
          <div className="inline-actions" style={{ justifyContent: "flex-start" }}>
            <button className="btn" disabled={saving || !draft.title.trim()} onClick={() => void save()}>
              {saving ? <span className="spin" /> : "保存"}
            </button>
            <button className="btn ghost" onClick={() => setDraft(null)}>取消</button>
            <label className="check-field" style={{ marginLeft: 8 }}>
              <input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} />
              置顶
            </label>
          </div>
        </section>
      )}

      {notes.length === 0 && !draft ? (
        <div className="empty">
          还没有笔记
          <div className="empty-action"><button className="btn" onClick={() => setDraft({ id: null, title: "", content: "", pinned: false })}>写第一篇</button></div>
        </div>
      ) : (
        notes.map((note) => (
          <section key={note.id} className="card section-card note-card">
            <div className="note-card-head">
              <button className="note-title-btn" aria-expanded={expanded === note.id}
                onClick={() => setExpanded(expanded === note.id ? null : note.id)}>
                <span className="note-caret">{expanded === note.id ? "▾" : "▸"}</span>
                {note.pinned && <span className="chip warn">置顶</span>}
                <b>{note.title}</b>
                <span className="note-meta">更新于 {note.updatedAt.slice(0, 10)}</span>
              </button>
              {expanded === note.id && (
                <div className="inline-actions">
                  <button className="btn ghost sm" onClick={() => void togglePin(note)}>{note.pinned ? "取消置顶" : "置顶"}</button>
                  <button className="btn ghost sm" onClick={() => setDraft({ id: note.id, title: note.title, content: note.content, pinned: note.pinned })}>编辑</button>
                  <button className="btn danger sm" onClick={() => void remove(note)}>删除</button>
                </div>
              )}
            </div>
            {expanded === note.id && <div className="note-content">{renderMarkdown(note.content)}</div>}
          </section>
        ))
      )}
    </div>
  );
}

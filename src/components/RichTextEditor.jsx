import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Color from '@tiptap/extension-color';
import TextStyle from '@tiptap/extension-text-style';
import { useState, useEffect, useRef, useCallback } from 'react';

const COLORS = [
  { label: 'Default', value: null },
  { label: 'Red',    value: '#ef4444' },
  { label: 'Orange', value: '#f59e0b' },
  { label: 'Green',  value: '#10b981' },
  { label: 'Blue',   value: '#3b82f6' },
  { label: 'Purple', value: '#8b5cf6' },
  { label: 'Pink',   value: '#ec4899' },
];

export default function RichTextEditor({ value, onChange, placeholder }) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      TextStyle,
      Color,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Image.configure({ inline: false, allowBase64: true }),
      Placeholder.configure({ placeholder: placeholder || 'Describe the task in detail…' }),
    ],
    content: value || '',
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.getHTML());
    },
  });

  // Sync external value changes (e.g. form reset or edit-mode load)
  const lastExternalValue = useRef(value);
  useEffect(() => {
    if (!editor) return;
    if (value !== lastExternalValue.current) {
      lastExternalValue.current = value;
      const currentHtml = editor.getHTML();
      if (value !== currentHtml) {
        editor.commands.setContent(value || '', false);
      }
    }
  }, [value, editor]);

  const addImage = useCallback(() => {
    if (!editor) return;
    const url = window.prompt('Image URL:');
    if (url) editor.chain().focus().setImage({ src: url }).run();
  }, [editor]);

  const handleFileInput = useCallback((e) => {
    if (!editor) return;
    const files = e.target.files;
    if (!files?.length) return;
    Array.from(files).forEach(file => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => editor.chain().focus().setImage({ src: reader.result }).run();
        reader.readAsDataURL(file);
      }
    });
    e.target.value = '';
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="rte-wrap">
      <Toolbar editor={editor} onAddImage={addImage} onFileInput={handleFileInput} />
      <EditorContent editor={editor} className="rte-content" />
    </div>
  );
}

// ─── Link Popup ──────────────────────────────────────────────────────────────

function LinkPopup({ editor, onClose }) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const popupRef = useRef(null);
  // Capture selection at open time (clicking popup blurs editor and clears selection)
  const selectionRef = useRef(null);

  useEffect(() => {
    const existingHref = editor.getAttributes('link').href || '';
    setUrl(existingHref || 'https://');

    const { from, to, empty } = editor.state.selection;
    selectionRef.current = { from, to, empty };
    if (!empty) {
      setText(editor.state.doc.textBetween(from, to, ''));
    } else {
      setText('');
    }
  }, [editor]);

  useEffect(() => {
    function handleClick(e) {
      if (popupRef.current && !popupRef.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  function handleApply(e) {
    e.preventDefault();
    e.stopPropagation();

    const trimmedUrl = url.trim();
    if (!trimmedUrl || trimmedUrl === 'https://') {
      editor.chain().focus().unsetLink().run();
      onClose();
      return;
    }

    const sel = selectionRef.current;
    const displayText = text.trim() || trimmedUrl;

    if (sel.empty) {
      // No selection — insert new text with link
      editor.chain().focus()
        .insertContent({ type: 'text', text: displayText, marks: [{ type: 'link', attrs: { href: trimmedUrl } }] })
        .run();
    } else {
      // Restore selection, replace text, apply link
      editor.chain().focus()
        .setTextSelection({ from: sel.from, to: sel.to })
        .deleteSelection()
        .insertContent({ type: 'text', text: displayText, marks: [{ type: 'link', attrs: { href: trimmedUrl } }] })
        .run();
    }
    onClose();
  }

  function handleRemove(e) {
    e.preventDefault();
    e.stopPropagation();
    const sel = selectionRef.current;
    if (sel && !sel.empty) {
      editor.chain().focus().setTextSelection({ from: sel.from, to: sel.to }).unsetLink().run();
    } else {
      editor.chain().focus().unsetLink().run();
    }
    onClose();
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { handleApply(e); }
    if (e.key === 'Escape') { onClose(); }
  }

  return (
    <div className="link-popup" ref={popupRef} onKeyDown={handleKeyDown}>
      <label className="link-popup-label">URL</label>
      <input
        className="link-popup-input"
        type="text"
        value={url}
        onChange={e => setUrl(e.target.value)}
        placeholder="https://example.com"
        autoFocus
      />
      <label className="link-popup-label" style={{ marginTop: 10 }}>Display text</label>
      <input
        className="link-popup-input"
        type="text"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Link text"
      />
      <div className="link-popup-actions">
        <button type="button" className="link-popup-btn link-popup-btn-primary" onClick={handleApply}>
          Apply
        </button>
        {editor.isActive('link') && (
          <button type="button" className="link-popup-btn link-popup-btn-danger" onClick={handleRemove}>
            Remove
          </button>
        )}
        <button type="button" className="link-popup-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({ editor, onAddImage, onFileInput }) {
  const fileRef = useRef(null);
  const [showLinkPopup, setShowLinkPopup] = useState(false);

  const handleLinkClick = useCallback(() => {
    setShowLinkPopup(prev => !prev);
  }, []);

  const activeHeading = editor.isActive('heading', { level: 1 }) ? 'H1'
    : editor.isActive('heading', { level: 2 }) ? 'H2'
    : editor.isActive('heading', { level: 3 }) ? 'H3'
    : 'Normal';

  return (
    <div className="rte-toolbar">
      {/* Text type */}
      <select
        className="rte-select"
        value={activeHeading}
        onChange={e => {
          const v = e.target.value;
          if (v === 'Normal') editor.chain().focus().setParagraph().run();
          else editor.chain().focus().toggleHeading({ level: parseInt(v[1]) }).run();
        }}
      >
        <option value="Normal">Normal</option>
        <option value="H1">Heading 1</option>
        <option value="H2">Heading 2</option>
        <option value="H3">Heading 3</option>
      </select>

      <span className="rte-sep" />

      {/* Bold */}
      <button type="button" className={`rte-btn ${editor.isActive('bold') ? 'active' : ''}`}
        onClick={() => editor.chain().focus().toggleBold().run()} title="Bold">
        <strong>B</strong>
      </button>

      {/* Italic */}
      <button type="button" className={`rte-btn ${editor.isActive('italic') ? 'active' : ''}`}
        onClick={() => editor.chain().focus().toggleItalic().run()} title="Italic">
        <em>I</em>
      </button>

      {/* Underline */}
      <button type="button" className={`rte-btn ${editor.isActive('underline') ? 'active' : ''}`}
        onClick={() => editor.chain().focus().toggleUnderline().run()} title="Underline">
        <u>U</u>
      </button>

      <span className="rte-sep" />

      {/* Text color */}
      <select
        className="rte-select rte-select-color"
        value={editor.getAttributes('textStyle').color || ''}
        onChange={e => {
          const c = e.target.value;
          if (!c) editor.chain().focus().unsetColor().run();
          else editor.chain().focus().setColor(c).run();
        }}
        title="Text color"
      >
        {COLORS.map(c => (
          <option key={c.label} value={c.value || ''} style={c.value ? { color: c.value } : undefined}>
            {c.label}
          </option>
        ))}
      </select>

      <span className="rte-sep" />

      {/* Bullet list */}
      <button type="button" className={`rte-btn ${editor.isActive('bulletList') ? 'active' : ''}`}
        onClick={() => editor.chain().focus().toggleBulletList().run()} title="Bullet list">
        &#8226;&#8801;
      </button>

      {/* Ordered list */}
      <button type="button" className={`rte-btn ${editor.isActive('orderedList') ? 'active' : ''}`}
        onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Numbered list">
        1.
      </button>

      <span className="rte-sep" />

      {/* Link */}
      <button
        type="button"
        className={`rte-btn ${editor.isActive('link') ? 'active' : ''}`}
        onClick={handleLinkClick}
        title="Add link"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
      </button>

      {showLinkPopup && (
        <LinkPopup editor={editor} onClose={() => setShowLinkPopup(false)} />
      )}

      {/* Image URL */}
      <button type="button" className="rte-btn" onClick={onAddImage} title="Insert image from URL">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
      </button>

      {/* Upload image */}
      <button type="button" className="rte-btn" onClick={() => fileRef.current?.click()} title="Upload image">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
      </button>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFileInput} />
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { getSession, signOut } from './supabase.js';
import {
  loadProject, loadOrderIntake, upsertCustomerInfo,
  loadLogosForProject, uploadLogo, deleteLogo,
} from './supabase.js';
import {
  GSForm, GSFormSection, GSField, GSButton, GSFileSelect,
} from 'golfstatus_react_components';
import 'golfstatus_react_components/dist/index.css';
import './landing.css';
import './customer.css';

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return `${months[m-1]} ${d}, ${y}`;
}

const EMPTY_CI = {
  course_name: '', event_name: '', event_date: '', contact_name: '', contact_email: '',
  country: 'US', attn: '', address_line1: '', address_line2: '', city: '',
  state_province: '', postal_code: '', flag_style: '', flag_setup: '',
  flag_qty: '', design_notes: '',
};

export default function CustomerPage() {
  const pid = new URLSearchParams(window.location.search).get('project');
  const [projectName, setProjectName] = useState('');
  const [ci, setCi] = useState(EMPTY_CI);
  const [intake, setIntake] = useState(null);
  const [logos, setLogos] = useState([]);
  const [saveStatus, setSaveStatus] = useState('');
  const [showOriginal, setShowOriginal] = useState(false);
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!pid) { window.location.href = '/'; return; }
    getSession().then(session => {
      if (!session) { window.location.href = `/login.html?next=${encodeURIComponent(window.location.pathname + window.location.search)}`; return; }
      loadData();
    }).catch(() => {});
  }, []);

  async function loadData() {
    try {
      const [project, orderIntake, loadedLogos] = await Promise.all([
        loadProject(pid),
        loadOrderIntake(pid).catch(() => null),
        loadLogosForProject(pid).catch(() => []),
      ]);
      setProjectName(project.name || '');
      setIntake(orderIntake);
      setLogos(loadedLogos);

      if (project.customer_info && Object.keys(project.customer_info).length) {
        setCi({ ...EMPTY_CI, ...project.customer_info });
      } else if (orderIntake) {
        setCi({
          course_name:    orderIntake.course_name    || '',
          event_name:     orderIntake.event_name     || '',
          event_date:     orderIntake.event_date     || '',
          contact_name:   orderIntake.contact_name   || '',
          contact_email:  orderIntake.contact_email  || '',
          country:        orderIntake.country        || 'US',
          attn:           orderIntake.attn           || '',
          address_line1:  orderIntake.address_line1  || '',
          address_line2:  orderIntake.address_line2  || '',
          city:           orderIntake.city           || '',
          state_province: orderIntake.state_province || '',
          postal_code:    orderIntake.postal_code    || '',
          flag_style:     orderIntake.flag_style     || '',
          flag_setup:     orderIntake.flag_setup     || '',
          flag_qty:       orderIntake.flag_qty       ?? '',
          design_notes:   orderIntake.design_notes   || '',
        });
      }
    } catch (err) {
      console.error('Failed to load', err);
    } finally {
      setLoading(false);
    }
  }

  function handleChange(field, value) {
    const next = { ...ci, [field]: value };
    if (field === 'country') next.state_province = '';
    setCi(next);
    scheduleSave(next);
  }

  function scheduleSave(data) {
    clearTimeout(saveTimer.current);
    setSaveStatus('saving');
    saveTimer.current = setTimeout(async () => {
      try {
        await upsertCustomerInfo(pid, data);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus(''), 2000);
      } catch (err) {
        console.error('Save failed', err);
        setSaveStatus('');
      }
    }, 800);
  }

  async function handleLogoUpload(e) {
    const files = Array.from(e.target.files);
    e.target.value = '';
    for (const file of files) {
      try {
        const logo = await uploadLogo(pid, file);
        setLogos(prev => [...prev, logo]);
      } catch (err) {
        console.error('Upload failed', err);
        alert('Could not upload: ' + file.name);
      }
    }
  }

  async function handleLogoDelete(logo) {
    try {
      await deleteLogo(logo.storagePath, logo.id);
      setLogos(prev => prev.filter(l => l.id !== logo.id));
    } catch (err) {
      console.error('Delete failed', err);
      alert('Could not remove logo.');
    }
  }

  // Build GSForm sections
  const formSections = [
    {
      sectionTitle: 'Event',
      fields: [
        {
          label: 'Event name',
          value: ci.event_name,
          isEditable: true,
          type: 'text',
          placeholder: 'e.g. Augusta Club Championship 2026',
          onChange: e => handleChange('event_name', e.target.value),
        },
        {
          label: 'Event date',
          value: ci.event_date,
          isEditable: true,
          type: 'date',
          onChange: e => handleChange('event_date', e.target.value),
        },
        {
          label: 'Course name',
          value: ci.course_name,
          isEditable: true,
          type: 'text',
          placeholder: 'e.g. Augusta National Golf Club',
          onChange: e => handleChange('course_name', e.target.value),
        },
      ],
    },
    {
      sectionTitle: 'Contact',
      fields: [
        {
          label: 'Full name',
          value: ci.contact_name,
          isEditable: true,
          type: 'text',
          onChange: e => handleChange('contact_name', e.target.value),
        },
        {
          label: 'Email',
          value: ci.contact_email,
          isEditable: true,
          type: 'email',
          onChange: e => handleChange('contact_email', e.target.value),
        },
      ],
    },
    {
      sectionTitle: 'Shipping address',
      fields: [
        {
          label: 'ATTN',
          value: ci.attn,
          isEditable: true,
          type: 'text',
          placeholder: ci.contact_name || 'Recipient name',
          onChange: e => handleChange('attn', e.target.value),
        },
        {
          label: 'Address line 1',
          value: ci.address_line1,
          isEditable: true,
          type: 'text',
          placeholder: 'Street address',
          onChange: e => handleChange('address_line1', e.target.value),
        },
        {
          label: 'Address line 2',
          value: ci.address_line2,
          isEditable: true,
          type: 'text',
          placeholder: 'Apt, suite, unit, etc.',
          onChange: e => handleChange('address_line2', e.target.value),
        },
        {
          label: 'City',
          value: ci.city,
          isEditable: true,
          type: 'text',
          onChange: e => handleChange('city', e.target.value),
        },
        {
          label: 'ZIP / Postal code',
          value: ci.postal_code,
          isEditable: true,
          type: 'text',
          onChange: e => handleChange('postal_code', e.target.value),
        },
      ],
    },
    {
      sectionTitle: 'Design preferences',
      sectionDescription: 'Informational only — does not affect the actual designs.',
      fields: [
        {
          label: 'Flag style',
          value: ci.flag_style,
          isEditable: true,
          type: 'text',
          placeholder: 'e.g. Classic',
          onChange: e => handleChange('flag_style', e.target.value),
        },
        {
          label: 'Flag setup',
          value: ci.flag_setup,
          isEditable: true,
          customView: true,
        },
        {
          label: 'Quantity',
          value: String(ci.flag_qty ?? ''),
          isEditable: true,
          type: 'number',
          onChange: e => handleChange('flag_qty', e.target.value),
        },
        {
          label: 'Design notes',
          value: ci.design_notes,
          isEditable: true,
          type: 'text-area',
          placeholder: 'Any specific design requests…',
          onChange: e => handleChange('design_notes', e.target.value),
        },
      ],
    },
  ];

  if (loading) {
    return (
      <div className="cu-page">
        <header>
          <div className="logo"><div className="logo-mark"></div>Flag Studio</div>
        </header>
        <div className="cu-loading">Loading…</div>
      </div>
    );
  }

  return (
    <div className="cu-page">
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
          <a href={`/project.html?project=${pid}`} className="back-link">← {projectName || 'Project'}</a>
          <div className="logo"><div className="logo-mark"></div>Flag Studio</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <span className={`cu-save-status ${saveStatus}`}>
            {saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : ''}
          </span>
          <a href={`/customer-plain.html?project=${pid}`} className="cu-version-toggle">
            Switch to plain view
          </a>
          <button className="sign-out-btn" onClick={async () => { await signOut(); window.location.href = '/login.html'; }}>
            Sign out
          </button>
        </div>
      </header>

      <div className="cu-main">
        <h1 className="cu-title">Customer Info</h1>

        <GSForm
          formSections={formSections.map(section => ({
            ...section,
            fields: section.fields.map(field => ({
              ...field,
              customView: field.customView
                ? field.label === 'Flag setup'
                  ? <FlagSetupSelect value={ci.flag_setup} onChange={v => handleChange('flag_setup', v)} />
                  : field.value
                : false,
            })),
          }))}
        />

        {/* Logos */}
        <div className="cu-section gs-section">
          <div className="cu-section-title">Logos</div>
          <div className="cu-logo-grid">
            {logos.length === 0 && <p className="cu-logo-empty">No logos uploaded yet.</p>}
            {logos.map(logo => <LogoItem key={logo.id} logo={logo} onDelete={handleLogoDelete} />)}
          </div>
          <GSButton
            title="Add logo"
            type="secondary"
            onClick={() => fileInputRef.current?.click()}
          />
          <input ref={fileInputRef} type="file"
            accept=".svg,.png,.pdf,.ai,.eps,image/*" multiple
            style={{ display: 'none' }} onChange={handleLogoUpload} />
        </div>

        {/* Original submission */}
        {intake && (
          <div className="cu-original">
            <button className="cu-original-toggle" onClick={() => setShowOriginal(v => !v)}>
              {showOriginal ? '▾' : '▸'} Original submission
            </button>
            {showOriginal && <OriginalPanel intake={intake} />}
          </div>
        )}
      </div>
    </div>
  );
}

function FlagSetupSelect({ value, onChange }) {
  return (
    <select className="cu-input" value={value} onChange={e => onChange(e.target.value)}>
      <option value="">Select…</option>
      <option value="same">Same front &amp; back</option>
      <option value="different">Different front &amp; back</option>
    </select>
  );
}

function LogoItem({ logo, onDelete }) {
  const ext = (logo.storagePath || '').split('.').pop().toLowerCase();
  const isImg = ['png','jpg','jpeg','gif','webp','svg'].includes(ext);
  return (
    <div className="cu-logo-item">
      {isImg
        ? <img src={logo.src} alt={logo.name} />
        : <div className="cu-logo-doc">{ext.toUpperCase() || 'FILE'}</div>}
      <div className="cu-logo-name">{logo.name}</div>
      <button className="cu-logo-del" onClick={() => onDelete(logo)} title="Remove">✕</button>
    </div>
  );
}

function OriginalPanel({ intake: o }) {
  const addr = [o.address_line1, o.address_line2,
    [o.city, o.state_province, o.postal_code].filter(Boolean).join(', '),
    o.country === 'CA' ? 'Canada' : 'USA'].filter(Boolean).join(', ');

  const rows = [
    ['Event',      `${o.event_name || '—'}${o.event_date ? ', ' + formatDate(o.event_date) : ''}`],
    ['Contact',    `${o.contact_name || '—'} · ${o.contact_email || '—'}`],
    ['Address',    addr || '—'],
    ['Flag style', o.flag_style || '—'],
    ['Setup',      o.flag_setup || '—'],
    ['Qty',        o.flag_qty ?? '—'],
    ...(o.design_notes ? [['Notes', o.design_notes]] : []),
  ];

  return (
    <div className="cu-original-panel">
      {rows.map(([label, value]) => (
        <div key={label} className="cu-orig-row">
          <span className="cu-orig-label">{label}</span>
          <span>{String(value)}</span>
        </div>
      ))}
    </div>
  );
}

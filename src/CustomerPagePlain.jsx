import { useState, useEffect, useRef } from 'react';
import { getSession, signOut } from './supabase.js';
import {
  loadProject, loadOrderIntake, upsertCustomerInfo,
  loadLogosForProject, uploadLogo, deleteLogo,
} from './supabase.js';
import './landing.css';
import './customer.css';

const US_STATES = [
  {code:'AL',name:'Alabama'},{code:'AK',name:'Alaska'},{code:'AZ',name:'Arizona'},
  {code:'AR',name:'Arkansas'},{code:'CA',name:'California'},{code:'CO',name:'Colorado'},
  {code:'CT',name:'Connecticut'},{code:'DE',name:'Delaware'},{code:'FL',name:'Florida'},
  {code:'GA',name:'Georgia'},{code:'HI',name:'Hawaii'},{code:'ID',name:'Idaho'},
  {code:'IL',name:'Illinois'},{code:'IN',name:'Indiana'},{code:'IA',name:'Iowa'},
  {code:'KS',name:'Kansas'},{code:'KY',name:'Kentucky'},{code:'LA',name:'Louisiana'},
  {code:'ME',name:'Maine'},{code:'MD',name:'Maryland'},{code:'MA',name:'Massachusetts'},
  {code:'MI',name:'Michigan'},{code:'MN',name:'Minnesota'},{code:'MS',name:'Mississippi'},
  {code:'MO',name:'Missouri'},{code:'MT',name:'Montana'},{code:'NE',name:'Nebraska'},
  {code:'NV',name:'Nevada'},{code:'NH',name:'New Hampshire'},{code:'NJ',name:'New Jersey'},
  {code:'NM',name:'New Mexico'},{code:'NY',name:'New York'},{code:'NC',name:'North Carolina'},
  {code:'ND',name:'North Dakota'},{code:'OH',name:'Ohio'},{code:'OK',name:'Oklahoma'},
  {code:'OR',name:'Oregon'},{code:'PA',name:'Pennsylvania'},{code:'RI',name:'Rhode Island'},
  {code:'SC',name:'South Carolina'},{code:'SD',name:'South Dakota'},{code:'TN',name:'Tennessee'},
  {code:'TX',name:'Texas'},{code:'UT',name:'Utah'},{code:'VT',name:'Vermont'},
  {code:'VA',name:'Virginia'},{code:'WA',name:'Washington'},{code:'WV',name:'West Virginia'},
  {code:'WI',name:'Wisconsin'},{code:'WY',name:'Wyoming'},{code:'DC',name:'Washington, D.C.'},
];
const CA_PROVINCES = [
  {code:'AB',name:'Alberta'},{code:'BC',name:'British Columbia'},{code:'MB',name:'Manitoba'},
  {code:'NB',name:'New Brunswick'},{code:'NL',name:'Newfoundland and Labrador'},
  {code:'NS',name:'Nova Scotia'},{code:'NT',name:'Northwest Territories'},
  {code:'NU',name:'Nunavut'},{code:'ON',name:'Ontario'},{code:'PE',name:'Prince Edward Island'},
  {code:'QC',name:'Quebec'},{code:'SK',name:'Saskatchewan'},{code:'YT',name:'Yukon'},
];

const EMPTY_CI = {
  course_name: '', event_name: '', event_date: '', contact_name: '', contact_email: '',
  country: 'US', address_line1: '', address_line2: '', city: '',
  state_province: '', postal_code: '', flag_style: '', flag_setup: '',
  flag_qty: '', design_notes: '',
};

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return `${months[m-1]} ${d}, ${y}`;
}

export default function CustomerPagePlain() {
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

  const regions = ci.country === 'CA' ? CA_PROVINCES : US_STATES;
  const stateLabel = ci.country === 'CA' ? 'Province' : 'State';
  const postalLabel = ci.country === 'CA' ? 'Postal code' : 'ZIP code';

  if (loading) {
    return (
      <div className="cu-page">
        <header><div className="logo"><div className="logo-mark"></div>Flag Studio</div></header>
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
          <a href={`/customer.html?project=${pid}`} className="cu-version-toggle">
            Switch to GS components
          </a>
          <button className="sign-out-btn" onClick={async () => { await signOut(); window.location.href = '/login.html'; }}>
            Sign out
          </button>
        </div>
      </header>

      <div className="cu-main">
        <h1 className="cu-title">Customer Info</h1>

        {/* Event */}
        <section className="cu-section">
          <h2 className="cu-section-title">Event</h2>
          <div className="cu-row" style={{ marginBottom: '.75rem' }}>
            <Field label="Event name">
              <input className="cu-input" type="text" value={ci.event_name}
                placeholder="e.g. Augusta Club Championship 2026"
                onChange={e => handleChange('event_name', e.target.value)} />
            </Field>
            <Field label="Event date">
              <input className="cu-input" type="date" value={ci.event_date}
                onChange={e => handleChange('event_date', e.target.value)} />
            </Field>
          </div>
          <Field label="Course name">
            <input className="cu-input" type="text" value={ci.course_name}
              placeholder="e.g. Augusta National Golf Club"
              onChange={e => handleChange('course_name', e.target.value)} />
          </Field>
        </section>

        {/* Contact */}
        <section className="cu-section">
          <h2 className="cu-section-title">Contact</h2>
          <div className="cu-row">
            <Field label="Full name">
              <input className="cu-input" type="text" value={ci.contact_name}
                autoComplete="name"
                onChange={e => handleChange('contact_name', e.target.value)} />
            </Field>
            <Field label="Email">
              <input className="cu-input" type="email" value={ci.contact_email}
                autoComplete="email"
                onChange={e => handleChange('contact_email', e.target.value)} />
            </Field>
          </div>
        </section>

        {/* Shipping */}
        <section className="cu-section">
          <h2 className="cu-section-title">Shipping address</h2>
          <div className="cu-country-toggle">
            <button className={`cu-country-btn${ci.country === 'US' ? ' active' : ''}`}
              onClick={() => handleChange('country', 'US')}>🇺🇸 United States</button>
            <button className={`cu-country-btn${ci.country === 'CA' ? ' active' : ''}`}
              onClick={() => handleChange('country', 'CA')}>🇨🇦 Canada</button>
          </div>
          <Field label="Address line 1">
            <input className="cu-input" type="text" value={ci.address_line1}
              placeholder="Street address" autoComplete="address-line1"
              onChange={e => handleChange('address_line1', e.target.value)} />
          </Field>
          <Field label={<>Address line 2 <span className="cu-optional">(optional)</span></>}>
            <input className="cu-input" type="text" value={ci.address_line2}
              placeholder="Apt, suite, unit, etc." autoComplete="address-line2"
              onChange={e => handleChange('address_line2', e.target.value)} />
          </Field>
          <div className="cu-row cu-row-3">
            <Field label="City">
              <input className="cu-input" type="text" value={ci.city}
                autoComplete="address-level2"
                onChange={e => handleChange('city', e.target.value)} />
            </Field>
            <Field label={stateLabel}>
              <select className="cu-input" value={ci.state_province}
                onChange={e => handleChange('state_province', e.target.value)}>
                <option value="">Select…</option>
                {regions.map(r => <option key={r.code} value={r.code}>{r.name}</option>)}
              </select>
            </Field>
            <Field label={postalLabel} className="cu-field-sm">
              <input className="cu-input" type="text" value={ci.postal_code}
                autoComplete="postal-code"
                onChange={e => handleChange('postal_code', e.target.value)} />
            </Field>
          </div>
        </section>

        {/* Design preferences */}
        <section className="cu-section">
          <h2 className="cu-section-title">
            Design preferences <span className="cu-info-note">(informational — does not affect designs)</span>
          </h2>
          <div className="cu-row cu-row-3">
            <Field label="Flag style">
              <input className="cu-input" type="text" value={ci.flag_style}
                placeholder="e.g. Classic"
                onChange={e => handleChange('flag_style', e.target.value)} />
            </Field>
            <Field label="Flag setup">
              <select className="cu-input" value={ci.flag_setup}
                onChange={e => handleChange('flag_setup', e.target.value)}>
                <option value="">Select…</option>
                <option value="same">Same front &amp; back</option>
                <option value="different">Different front &amp; back</option>
              </select>
            </Field>
            <Field label="Quantity" className="cu-field-sm">
              <input className="cu-input" type="number" min="1" value={ci.flag_qty}
                onChange={e => handleChange('flag_qty', e.target.value)} />
            </Field>
          </div>
          <Field label="Design notes">
            <textarea className="cu-input cu-textarea" value={ci.design_notes}
              placeholder="Any specific design requests…"
              onChange={e => handleChange('design_notes', e.target.value)} />
          </Field>
        </section>

        {/* Logos */}
        <section className="cu-section">
          <h2 className="cu-section-title">Logos</h2>
          <div className="cu-logo-grid">
            {logos.length === 0 && <p className="cu-logo-empty">No logos uploaded yet.</p>}
            {logos.map(logo => <LogoItem key={logo.id} logo={logo} onDelete={handleLogoDelete} />)}
          </div>
          <button className="cu-add-logo-btn" onClick={() => fileInputRef.current?.click()}>
            + Add logo
          </button>
          <input ref={fileInputRef} type="file"
            accept=".svg,.png,.pdf,.ai,.eps,image/*" multiple
            style={{ display: 'none' }} onChange={handleLogoUpload} />
        </section>

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

function Field({ label, children, className = '' }) {
  return (
    <div className={`cu-field ${className}`}>
      <label className="cu-label">{label}</label>
      {children}
    </div>
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

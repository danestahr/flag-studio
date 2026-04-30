# Flag Studio — Roadmap

## Phase 1 — Supabase integration (orders + storage)

### Database schema

```sql
-- Flag orders table
create table flag_orders (
  id uuid default gen_random_uuid() primary key,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),

  -- Customer / event info
  event_name text,
  contact_email text,
  status text default 'draft', -- draft | submitted | in_production | complete

  -- Master config (JSON)
  flag_id text not null,                    -- 'edinburgh' | 'ascot' | 'plain'
  colors jsonb not null default '{}',       -- { "zone-primary": "#1A3A6B", ... }

  -- Variations (JSON array)
  variations jsonb not null default '[]',
  -- Each variation: { id, name, assignment: { "lz-main": "logo-url" } }

  -- Rendered output URLs (populated server-side after export)
  rendered_urls jsonb default '{}',         -- { "var-id": "https://..." }

  -- Metadata
  quantity integer default 1,
  notes text
);

-- Logo assets table (shared library per order)
create table flag_logos (
  id uuid default gen_random_uuid() primary key,
  order_id uuid references flag_orders(id) on delete cascade,
  name text,
  storage_path text not null,   -- Supabase Storage path
  public_url text not null,
  uploaded_at timestamp with time zone default now()
);

-- Row-level security
alter table flag_orders enable row level security;
alter table flag_logos enable row level security;
```

### Supabase Storage buckets

```
flag-logos/          # User-uploaded logo files
  {order_id}/        # Scoped per order
    logo-abc.png
    logo-xyz.svg

flag-renders/        # Server-rendered output
  {order_id}/
    variation-1.png
    variation-1.svg
```

### Key flows

**Save draft:**
1. Serialize `state` (flagId, colors, variations, logo assignments) to JSON
2. Upload any new logo files to `flag-logos/{orderId}/` in Storage
3. Replace base64 srcs in state with public Storage URLs
4. Upsert row in `flag_orders`

**Load existing order:**
1. Fetch row from `flag_orders` by id
2. Fetch logo records from `flag_logos` for that order
3. Reconstruct `state` object and re-initialize configurator

**Submit for production:**
1. Set `status = 'submitted'`
2. Trigger server-side render job (Edge Function or external)
3. Store rendered PNG/SVG URLs back to `rendered_urls`

---

## Phase 2 — Google Forms + Sheets integration

### Concept

A Google Form captures the order intent (event name, flag style, color choices, logo uploads). On submission, a Google Sheet row is created. An Apps Script webhook or Supabase Edge Function reads the row and auto-generates the flag configuration — bypassing the manual UI entirely for standard orders.

The configurator UI becomes the **editor** for custom or edge-case work.

### Google Form fields

| Field | Type | Maps to |
|---|---|---|
| Event name | Short text | `event_name` |
| Contact email | Email | `contact_email` |
| Flag style | Multiple choice | `flag_id` |
| Field color | Dropdown (color names) | `colors.zone-primary` |
| Stripe color | Dropdown | `colors.zone-secondary` |
| Logo upload | File upload | uploaded to Drive → Storage |
| Quantity | Number | `quantity` |
| Notes | Paragraph | `notes` |

### Apps Script → Supabase flow

```javascript
// In Google Apps Script, trigger on form submit:
function onFormSubmit(e) {
  const row = e.values;
  const payload = {
    event_name:    row[1],
    contact_email: row[2],
    flag_id:       slugify(row[3]),
    colors: {
      'zone-primary':   colorNameToHex(row[4]),
      'zone-secondary': colorNameToHex(row[5]),
    },
    variations: [{
      id: 'v1', name: 'Main', assignment: {}
    }],
    quantity: parseInt(row[7]) || 1,
    notes: row[8],
    status: 'submitted'
  };

  // POST to Supabase
  const url = 'https://YOUR_PROJECT.supabase.co/rest/v1/flag_orders';
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY },
    payload: JSON.stringify(payload)
  });
}
```

### Manual edit flow

From a Supabase dashboard or simple admin UI:
1. List `flag_orders` rows with `status = 'submitted'`
2. Click any order → opens configurator pre-loaded with that order's config
3. Make edits → save back to Supabase
4. Trigger render → generates final PNG/SVG output

---

## Phase 3 — Server-side rendering at full resolution

For print-quality output at `7519×4670px`:

```
Browser submits order JSON
  → Supabase Edge Function (or separate Node service)
  → Fetches logo files from Storage
  → Renders SVG with node-canvas or Puppeteer
  → Saves PNG to flag-renders/{orderId}/
  → Updates flag_orders.rendered_urls
  → Notifies via email or webhook
```

**Stack options:**
- `sharp` + inline SVG manipulation (fastest, no browser)
- `puppeteer` (most faithful to browser rendering)
- Hosted render service (Bannerbear, APITemplate.io) for simplicity

---

## Phase 4 — Admin dashboard

Simple React/Next.js app (or even a Supabase Studio extension) showing:
- Order queue with status filters
- Per-order detail: config summary, variation thumbnails, rendered outputs
- Direct link to open any order in the configurator for editing
- Bulk export / download all renders for an order

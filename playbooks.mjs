/**
 * playbooks.mjs — what the agent KNOWS about the software it is looking at.
 *
 * This is the difference between "a browser that an agent can click" and "an agent that
 * can actually work inside HubSpot". A playbook is procedural knowledge for one app:
 * how the product is laid out, what a task really involves there, and the traps.
 *
 * Deliberately NOT brittle CSS selectors. The agent grounds every step against a live
 * @eN snapshot, so what it needs from us is *procedure*, not coordinates — that survives
 * the vendor's next redesign, which selectors never do.
 *
 * Consequence for the product: a competitor's SaaS stops being a place the user has to
 * go and learn. It becomes a surface the agent operates. HubSpot stays the best CRM —
 * it just gets used by an employee who never gets bored of data entry.
 */

/** @typedef {{id:string,label:string,goal:string,steps:string[],confirm?:boolean,inputs?:string[]}} Task */

export const PLAYBOOKS = [
  {
    id: 'hubspot',
    name: 'HubSpot',
    match: /(^|\.)hubspot\.com$/i,
    notes: [
      'Left rail is the object switcher (Contacts, Companies, Deals, Tickets).',
      'Object tables have an inline "Actions" menu; bulk actions appear after selecting rows.',
      'Creating a record opens a right-hand drawer, not a new page — stay in the drawer until Save.',
      'Free portals hide some bulk tools; if an action is gated, say so instead of clicking upsells.',
    ],
    tasks: [
      { id: 'create_contact', label: 'Create a contact', inputs: ['email', 'firstname', 'lastname', 'company'],
        goal: 'Create one contact record with the given fields',
        steps: ['Open Contacts from the left rail', 'Click "Create contact"',
                'Fill email, first name, last name, company in the drawer', 'Click "Create"',
                'Confirm the record page or toast appeared'] },
      { id: 'bulk_import', label: 'Add several contacts', inputs: ['rows'],
        goal: 'Add each provided contact as a record',
        steps: ['Open Contacts', 'For each row: Create contact, fill fields, Create',
                'Skip a row if its email already exists (HubSpot warns about duplicates)'] },
      { id: 'log_activity', label: 'Log a call/note on a record', inputs: ['record', 'note'],
        goal: 'Attach an activity to the right record',
        steps: ['Search the record by name or email', 'Open it',
                'Use the Note (or Call) tab in the activity composer', 'Paste the note', 'Save'] },
      { id: 'find_duplicates', label: 'Find duplicate contacts',
        goal: 'Report likely duplicates without deleting anything',
        steps: ['Open Contacts', 'Sort or search by email/name', 'Collect records sharing an email or a name+company',
                'Report the list — never merge or delete without explicit confirmation'], confirm: true },
      { id: 'update_deal_stage', label: 'Move a deal to another stage', inputs: ['deal', 'stage'],
        goal: 'Change one deal stage',
        steps: ['Open Deals', 'Find the deal', 'Open it and change the Deal stage field', 'Save'], confirm: true },
      { id: 'export_view', label: 'Export the current list',
        goal: 'Export the visible table',
        steps: ['With the list open, use the "Export" action', 'Choose CSV', 'Confirm — the file is emailed by HubSpot'] },
    ],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    match: /(^|\.)(force|salesforce)\.com$/i,
    notes: [
      'Lightning UI: the App Launcher (grid icon) reaches objects that are not pinned.',
      'Records open in tabs; "New" buttons live at the top-right of a list view.',
      'Required fields are marked with a red bar — a Save that does nothing usually means a hidden required field above the fold.',
    ],
    tasks: [
      { id: 'create_lead', label: 'Create a lead', inputs: ['lastname', 'company', 'email'],
        goal: 'Create a Lead record',
        steps: ['Open Leads (App Launcher if not pinned)', 'Click New', 'Fill Last Name, Company, Email',
                'Save', 'Scroll for unfilled required fields if Save is rejected'] },
      { id: 'log_call', label: 'Log a call', inputs: ['record', 'note'],
        goal: 'Log an activity on a record',
        steps: ['Open the record', 'Activity tab → Log a Call', 'Paste the note', 'Save'] },
      { id: 'update_opp', label: 'Update an opportunity stage', inputs: ['opportunity', 'stage'],
        goal: 'Change one opportunity stage',
        steps: ['Open Opportunities', 'Open the record', 'Edit Stage', 'Save'], confirm: true },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    match: /(^|\.)notion\.(so|site)$/i,
    notes: ['Everything is a block; "/" opens the block menu.',
            'Databases: "New" adds a row and opens it as a page.',
            'Typing into a page is immediate — there is no Save button.'],
    tasks: [
      { id: 'add_row', label: 'Add a database row', inputs: ['database', 'fields'],
        goal: 'Add one row to a database and fill its properties',
        steps: ['Open the database', 'Click New', 'Fill the title then each property in the page that opens', 'Close the page'] },
      { id: 'append_note', label: 'Append a note to a page', inputs: ['page', 'text'],
        goal: 'Add text at the end of a page',
        steps: ['Open the page', 'Click at the end of the last block', 'Type the text'] },
    ],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    match: /(^|\.)mail\.google\.com$/i,
    notes: ['Compose is bottom-right; the recipient field autocompletes and needs Enter to commit a chip.',
            'Never send without explicit confirmation.'],
    tasks: [
      { id: 'draft_reply', label: 'Draft a reply (no send)', inputs: ['thread', 'message'],
        goal: 'Write a reply and leave it as a draft',
        steps: ['Open the thread', 'Click Reply', 'Type the message', 'Leave it unsent — close the composer so it saves as a draft'] },
      { id: 'find_thread', label: 'Find a conversation', inputs: ['query'],
        goal: 'Locate and summarise a thread',
        steps: ['Use the search bar', 'Open the best match', 'Summarise the last messages'] },
    ],
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    match: /(^|\.)linkedin\.com$/i,
    notes: ['Aggressive automation detection: act slowly, never loop.',
            'Connection requests and messages are rate-limited by LinkedIn itself.',
            'Only ever act on what the logged-in human could do by hand.'],
    tasks: [
      { id: 'read_profile', label: 'Read a profile', inputs: ['profile'],
        goal: 'Summarise a profile for outreach context',
        steps: ['Open the profile URL', 'Read headline, current role, recent activity', 'Summarise — do not connect or message'] },
      { id: 'draft_message', label: 'Draft a message (no send)', inputs: ['profile', 'message'],
        goal: 'Prepare a message without sending',
        steps: ['Open the conversation', 'Type the message', 'Stop before Send and report'], confirm: true },
    ],
  },
  {
    id: 'sheets',
    name: 'Google Sheets',
    match: /(^|\.)docs\.google\.com$/i,
    notes: ['The grid is a canvas: click a cell, then type — the value commits on Enter.',
            'Use the Name Box to jump to a cell reference reliably.'],
    tasks: [
      { id: 'append_rows', label: 'Append rows', inputs: ['rows'],
        goal: 'Add rows at the bottom of the sheet',
        steps: ['Jump to the first empty row', 'Type each cell, Tab across, Enter to end the row'] },
      { id: 'read_range', label: 'Read a range', inputs: ['range'],
        goal: 'Report the values in a range',
        steps: ['Use the Name Box to select the range', 'Read the visible values'] },
    ],
  },
  {
    id: 'stripe', name: 'Stripe', match: /(^|\.)dashboard\.stripe\.com$/i,
    notes: ['Read-heavy: reporting is safe, money actions are not.',
            'Refunds, payouts and subscription changes always require explicit confirmation.'],
    tasks: [
      { id: 'find_customer', label: 'Find a customer', inputs: ['query'],
        goal: 'Locate a customer and summarise their state',
        steps: ['Search the email or name', 'Open the customer', 'Report subscriptions, invoices, failed payments'] },
      { id: 'failed_payments', label: 'List failed payments',
        goal: 'Report recent failed payments',
        steps: ['Open Payments', 'Filter status = failed', 'Report the rows'] },
    ],
  },
];

/** Generic fallback so the agent is never useless on an unknown app. */
export const GENERIC = {
  id: 'generic', name: 'this app', match: null,
  notes: ['Unknown app: read the page before acting, and prefer reversible actions.'],
  tasks: [
    { id: 'summarise', label: 'Summarise this page', goal: 'Explain what is on screen and what can be done here',
      steps: ['Snapshot the page', 'Report the main content and the primary actions'] },
    { id: 'extract', label: 'Extract the data on screen', inputs: ['what'],
      goal: 'Pull the visible records into structured rows',
      steps: ['Snapshot', 'Read the table or list', 'Return rows as JSON'] },
    { id: 'fill_form', label: 'Fill the form on screen', inputs: ['values'],
      goal: 'Complete the visible form',
      steps: ['Snapshot to map the fields', 'Fill each field', 'Stop before the final submit and confirm'], confirm: true },
  ],
};

/** Identify the app behind a URL. Always returns a playbook (GENERIC when unknown). */
export function detect(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* not a URL yet */ }
  const hit = PLAYBOOKS.find((p) => p.match && p.match.test(host));
  return hit || { ...GENERIC, host };
}

/** Compact, promptable form of a playbook — this is what the agent is briefed with. */
export function brief(pb) {
  return [
    `APP: ${pb.name}`,
    pb.notes?.length ? `WHAT YOU KNOW ABOUT IT:\n- ${pb.notes.join('\n- ')}` : '',
    `TASKS YOU CAN DO HERE:\n${pb.tasks.map((t) => `- ${t.id}: ${t.label}${t.confirm ? ' (needs confirmation)' : ''}`).join('\n')}`,
  ].filter(Boolean).join('\n');
}

export function findTask(pb, id) {
  return pb.tasks.find((t) => t.id === id) || GENERIC.tasks.find((t) => t.id === id) || null;
}

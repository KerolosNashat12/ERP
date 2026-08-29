/**
 * صفحة فواتيرك — the invoices the shop already has on paper.
 *
 * *"اضيف فيها كل صور فواتيري … واربطها بمورد معين … واقول تحت الصوره ان تم تدفع
 * الفاتوره دي كامله ولا لسه متبقي عليها"*
 *
 * ── The one thing this screen must never let happen ─────────────────────────
 *
 * The person reading it has to know, without being told twice, that these
 * amounts are NOT the shop's accounts. A shop owner who later finds them
 * double-counted in his profit stops trusting every number in the system, so
 * the separation is said on the page rather than hidden in a comment: the
 * subtitle says it, a callout under the heading says it in full, and the money
 * tiles carry the words «خارج حسابات المحل» so a photograph of this screen can
 * never be mistaken for a photograph of the costs page. All of it through
 * `t()`, so it reads the same way in Arabic.
 *
 * ── Finding one again six months later ──────────────────────────────────────
 *
 * Two hundred photographs with names is not findable, so the filter bar is the
 * feature and not decoration. He searches by what he actually remembers: the
 * name he gave it, the number written on the paper, or the supplier — one box
 * covers all three, because he does not think of typing a supplier's name and
 * picking one from a list as two different acts. Beside it: the supplier, the
 * status, the dates on the paper, and the one question that brings him here at
 * all — «اللي لسه عليا بس».
 *
 * Every string comes through `t()`; there is not a literal in this file.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, toast, toastError, textInput, selectInput,
  field, modal, debounce, buildForm, confirmDialog, tag, checkboxInput,
} from '../core/ui.js';
import { t, pick } from '../core/i18n.js';
import { money, number, date } from '../core/format.js';
import { can, lookup } from '../core/store.js';
import { proofThumbs, proofPicker, proofUrl, openProof } from '../core/proof.js';
import { preparePhoto } from '../core/photo.js';

const METHODS = ['cash', 'card', 'transfer', 'wallet', 'cheque'];
const STATUSES = ['unknown', 'unpaid', 'partial', 'paid'];

/** The status word, and the colour a glance reads it by. */
const STATUS_TAG = {
  unknown: ['invoiceUnknown', ''],
  unpaid: ['invoiceUnpaid', 'danger'],
  partial: ['invoicePartial', 'warn'],
  paid: ['invoicePaid', 'ok'],
};

const statusTagFor = (row) => {
  const [key, kind] = STATUS_TAG[row.status] || STATUS_TAG.unknown;
  return h('div', { class: 'stack', style: { gap: '3px' } },
    tag(t(key), kind),
    // Never silent: more paid than the invoice says it came to means one of the
    // two numbers is wrong, and only he can say which.
    row.over_paid
      ? tag(t('invoiceOverPaidBy').replace('{amount}', money(row.over_paid)), 'warn')
      : null);
};

/**
 * "3 photos" / "صورة واحدة". English needs the singular said differently and
 * "1 photo(s)" on a shop owner's screen is somebody else's problem showing
 * through, so the one plural in this feature is handled rather than papered
 * over with brackets.
 */
const photoCountLabel = (count) => (count === 1
  ? t('onePhoto')
  : t('photoCount').replace('{count}', number(count)));

/** What a photograph of this invoice is called when it is opened full size. */
const invoiceCaption = (row) => [row.title, pick(row, 'supplier_name'), row.invoice_no]
  .filter(Boolean).join(' — ');

/**
 * Several photographs, because a paper invoice is several pages.
 *
 * `proofPicker` handles exactly one — the phone-side resize, the rotation and
 * the weight are all in there and must not be copied — so this is a list of
 * them with a button that adds the next. Nothing new happens to the bytes here.
 */
function photoPagePicker() {
  const pickers = [];
  const host = h('div', { class: 'stack' });
  const counter = h('span', { class: 'muted small' });

  /**
   * One more page. `file` fills it immediately — that is how several
   * photographs chosen from the gallery at once become several pages without
   * the person going back through the picker for each of them.
   */
  const addPage = (file = null) => {
    const picker = proofPicker({
      hint: t('invoicePhotosHint'),
      alt: t('invoicePhotos'),
      // A paper invoice is several pages and they are all in the gallery
      // together, so the sheet lets him select them in one go.
      multiple: true,
      onExtra: async (extras) => {
        for (const extra of extras) await addPage(extra);
      },
    });
    pickers.push(picker);
    render();
    if (file) {
      // Kicked off after the node is on the page, so the "preparing…" line is
      // visible while a large photograph is being resized.
      picker.accept(file).then(render);
    }
    return picker;
  };

  function render() {
    mount(host,
      ...pickers.map((picker) => picker.node),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn sm', type: 'button', onclick: addPage }, `＋ ${t('addAnotherPhoto')}`),
        counter));
    counter.textContent = photoCountLabel(value().length);
  }

  const value = () => pickers.map((picker) => picker.value()).filter(Boolean);

  addPage();
  return {
    node: host,
    value,
    isBusy: () => pickers.some((picker) => picker.isBusy()),
    refresh: render,
  };
}

export async function legacyInvoicesView(root, route) {
  const state = {
    filters: {
      search: route.query.search || '',
      supplierId: route.query.supplierId || '',
      status: route.query.status || '',
      outstandingOnly: route.query.outstandingOnly === '1',
      dateFrom: route.query.dateFrom || '',
      dateTo: route.query.dateTo || '',
    },
    page: 1,
  };

  const suppliers = await lookup('suppliers', '/api/suppliers/options');

  const kpiHost = h('div', { class: 'kpis', style: { marginBottom: '14px' } });
  const listHost = h('div', { class: 'card-body tight' }, spinner());
  const pagerHost = h('div');

  const query = () => ({
    ...state.filters,
    outstandingOnly: state.filters.outstandingOnly ? '1' : '',
    page: state.page,
    pageSize: 25,
  });

  async function load() {
    mount(listHost, spinner());
    try {
      const [data, summary] = await Promise.all([
        api.get('/api/legacy-invoices', query()),
        api.get('/api/legacy-invoices/summary', query()),
      ]);
      renderKpis(summary);
      renderTable(data);
    } catch (error) {
      toastError(error);
      mount(listHost, h('div', { class: 'empty' }, error.message));
    }
  }

  /**
   * The four numbers, each labelled as the archive's own.
   *
   * Every tile carries `outsideTheAccounts` under it. That repetition is
   * deliberate: a tile is what gets screenshotted, quoted on the phone and
   * remembered, and one that says "Still owed 12,400" with nothing beside it is
   * exactly the number somebody later adds to a supplier balance.
   */
  function renderKpis(summary) {
    const outside = t('outsideTheAccounts');
    mount(kpiHost,
      h('div', { class: 'kpi' },
        h('div', { class: 'label' }, t('filedInvoices')),
        h('div', { class: 'value' }, number(summary.invoices)),
        h('div', { class: 'sub' }, summary.without_amount
          ? `${number(summary.without_amount)} ${t('withoutAmountYet')}`
          : outside)),
      h('div', { class: 'kpi' },
        h('div', { class: 'label' }, t('archiveTotal')),
        h('div', { class: 'value' }, money(summary.total_amount)),
        h('div', { class: 'sub' }, outside)),
      h('div', { class: 'kpi' },
        h('div', { class: 'label' }, t('archivePaid')),
        h('div', { class: 'value' }, money(summary.paid_amount)),
        h('div', { class: 'sub' }, outside)),
      h('div', { class: 'kpi accent' },
        h('div', { class: 'label' }, t('stillOwed')),
        h('div', { class: 'value' }, money(summary.outstanding)),
        h('div', { class: 'sub' }, outside)));
  }

  function renderTable(data) {
    mount(listHost, dataTable({
      columns: [
        {
          key: 'photos',
          label: t('invoicePhotos'),
          render: (row) => proofThumbs(row.attachments, invoiceCaption(row)),
        },
        {
          key: 'title',
          label: t('invoiceName'),
          render: (row) => h('div', {},
            h('div', {}, row.title),
            // `dir="ltr"` because an invoice number is a code, not prose: in
            // the Arabic layout the leading # would otherwise be pushed to the
            // far end of it and read as part of the next thing along.
            row.invoice_no
              ? h('small', { class: 'muted mono', dir: 'ltr' }, `#${row.invoice_no}`)
              : null),
        },
        { key: 'supplier', label: t('supplier'), render: (row) => pick(row, 'supplier_name') },
        {
          key: 'invoice_date',
          label: t('invoicePaperDate'),
          render: (row) => (row.invoice_date ? date(row.invoice_date) : '—'),
        },
        {
          key: 'total_amount',
          label: t('invoiceTotal'),
          type: 'money',
          class: 'amount',
          // The honest answer when he has not read the amount off the paper
          // yet, rather than a zero that looks like a settled invoice.
          render: (row) => (row.total_amount === null
            ? h('span', { class: 'muted' }, t('invoiceUnknown'))
            : money(row.total_amount)),
        },
        { key: 'paid_amount', label: t('paid'), type: 'money', render: (row) => money(row.paid_amount) },
        {
          key: 'outstanding',
          label: t('stillOwed'),
          type: 'money',
          render: (row) => (row.outstanding === null ? '—' : money(row.outstanding)),
        },
        { key: 'status', label: t('status'), render: statusTagFor },
        {
          key: '__actions',
          label: t('actions'),
          class: 'nowrap',
          render: (row) => h('div', { class: 'row-actions' },
            h('button', {
              class: 'btn sm',
              onclick: () => openInvoice(row.id),
            }, t('paymentsOnThisInvoice')),
            can('legacy_invoices.update')
              ? h('button', { class: 'btn sm ghost', title: t('edit'), onclick: () => openForm(row) }, '✎')
              : null,
            can('legacy_invoices.delete')
              ? h('button', {
                class: 'btn sm ghost',
                title: t('delete'),
                onclick: async () => {
                  const ok = await confirmDialog({
                    title: t('delete'),
                    message: t('deleteLegacyInvoiceConfirm'),
                    danger: true,
                    confirmLabel: t('delete'),
                  });
                  if (!ok) return;
                  try {
                    await api.del(`/api/legacy-invoices/${row.id}`);
                    toast(t('legacyInvoiceDeleted'));
                    load();
                  } catch (error) { toastError(error); }
                },
              }, '🗑')
              : null),
        },
      ],
      rows: data.rows,
      onRowClick: (row) => openInvoice(row.id),
      emptyMessage: t('noLegacyInvoices'),
    }));
    mount(pagerHost, pager({
      page: data.page, pages: data.pages, total: data.total,
      onPage: (p) => { state.page = p; load(); },
    }));
  }

  // ------------------------------------------------------- filing one

  function openForm(record = null) {
    const form = buildForm([
      {
        name: 'title',
        label: t('invoiceName'),
        required: true,
        span: 2,
        hint: t('invoiceNameHint'),
      },
      {
        name: 'supplier_id',
        label: t('supplier'),
        type: 'select',
        required: true,
        options: suppliers.map((s) => ({ value: s.id, label: pick(s, 'name') })),
      },
      { name: 'invoice_no', label: t('invoiceNumber') },
      { name: 'invoice_date', label: t('invoicePaperDate'), type: 'date' },
      {
        name: 'total_amount',
        label: t('invoiceTotal'),
        type: 'number',
        // NOT required, and the hint says why. He photographs a bill today and
        // reads the amount off it next week; a form that refuses the
        // photograph until he types a number is a form he stops using.
        hint: t('invoiceTotalHint'),
      },
      { name: 'notes', label: t('invoiceNotes'), type: 'textarea', span: 2 },
      /*
       * No default date. Everything on this page is old paper — pre-filling
       * today would file a 2023 invoice as if it were this morning's, and the
       * date is one of the things he searches by six months later. An empty box
       * asks the question; a filled one answers it wrongly on his behalf.
       */
    ], record || {}, { columns: 2 });

    const photos = photoPagePicker();

    const dialog = modal({
      title: record ? `${t('editLegacyInvoice')} — ${record.title}` : t('newLegacyInvoice'),
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'callout' }, t('legacyInvoicesNotice')),
        form.node,
        record?.attachments?.length
          ? field({ label: t('invoicePhotos'), input: proofThumbs(record.attachments, invoiceCaption(record)) })
          : null,
        // The hint lives on the picker itself (see `photoPagePicker`), so the
        // field wrapper does not repeat it back at him.
        field({ label: record ? t('addAnotherPhoto') : t('invoicePhotos'), input: photos.node })),
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            // A photograph still being compressed is a photograph a save that
            // went now would leave behind.
            if (photos.isBusy()) { toast(t('preparingPhoto'), 'warn'); return; }
            const taken = photos.value();
            if (!record && !taken.length) { toast(t('invoicePhotoNeeded'), 'warn'); return; }
            const values = form.values();
            const payload = {
              title: values.title,
              supplier_id: Number(values.supplier_id),
              invoice_no: values.invoice_no || null,
              invoice_date: values.invoice_date || null,
              // Sent as typed and rounded by the server; `null` is a real
              // answer meaning "not read off the paper yet".
              total_amount: values.total_amount === null ? null : Number(values.total_amount),
              notes: values.notes || null,
              photos: taken,
            };
            try {
              if (record) await api.put(`/api/legacy-invoices/${record.id}`, payload);
              else await api.post('/api/legacy-invoices', payload);
              toast(t('legacyInvoiceSaved'));
              dialog.close();
              load();
            } catch (error) {
              if (error.details?.length) form.setErrors(error.details);
              toastError(error);
            }
          },
        }, t('save')),
      ],
    });
  }

  // ------------------------------------------- one invoice, and its payments

  /**
   * The invoice opened: its pages, its numbers, and every payment recorded
   * against it with the receipt attached to each.
   *
   * The thumbnails point at `?size=thumb` — the ~20 KB preview the browser made
   * when the photograph was taken — and the readable photograph is fetched only
   * when somebody actually opens one. See `core/proof.js`.
   */
  function openInvoice(id) {
    const body = h('div', { class: 'stack' }, spinner());
    const dialog = modal({ title: t('legacyInvoices'), size: 'wide', body });

    async function refresh() {
      try {
        const data = await api.get(`/api/legacy-invoices/${id}/payments`);
        const invoice = data.invoice;
        // The dialog opens before the record has arrived, so it is titled with
        // the page's name and then with the invoice's own — which is what he
        // called it, and the only thing that tells two open records apart.
        const heading = dialog.dialog.querySelector('.modal-head h3');
        if (heading) heading.textContent = invoice.title;
        mount(body,
          h('div', { class: 'callout' },
            h('strong', {}, `${t('outsideTheAccounts')}. `),
            t('legacyInvoicesNotice')),

          h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', alignItems: 'baseline' } },
            h('h3', { style: { margin: 0 } }, invoice.title),
            statusTagFor(invoice),
            h('span', { class: 'muted small' },
              [pick(invoice, 'supplier_name'),
                invoice.invoice_date ? date(invoice.invoice_date) : null].filter(Boolean).join(' · ')),
            invoice.invoice_no
              ? h('span', { class: 'muted small mono', dir: 'ltr' }, `#${invoice.invoice_no}`)
              : null),

          invoice.status === 'unknown'
            ? h('p', { class: 'muted small' }, t('invoiceUnknownHint'))
            : null,
          invoice.over_paid
            ? h('p', { class: 'muted small' }, t('invoiceOverPaidHint'))
            : null,

          h('div', { class: 'kpis' },
            h('div', { class: 'kpi' },
              h('div', { class: 'label' }, t('invoiceTotal')),
              h('div', { class: 'value' }, invoice.total_amount === null
                ? t('invoiceUnknown') : money(invoice.total_amount)),
              h('div', { class: 'sub' }, t('outsideTheAccounts'))),
            h('div', { class: 'kpi' },
              h('div', { class: 'label' }, t('paid')),
              h('div', { class: 'value' }, money(invoice.paid_amount)),
              h('div', { class: 'sub' }, t('outsideTheAccounts'))),
            h('div', { class: 'kpi accent' },
              h('div', { class: 'label' }, t('stillOwed')),
              h('div', { class: 'value' }, invoice.outstanding === null
                ? '—' : money(invoice.outstanding)),
              h('div', { class: 'sub' }, t('outsideTheAccounts')))),

          photoStrip(invoice, refresh),

          h('div', { class: 'card' },
            h('div', { class: 'card-head' },
              h('h3', {}, t('paymentsOnThisInvoice')),
              h('span', { class: 'spacer' }),
              can('legacy_invoices.pay')
                ? h('button', {
                  class: 'btn sm primary',
                  onclick: () => openPayment(invoice, refresh),
                }, `＋ ${t('registerPayment')}`)
                : null),
            h('div', { class: 'card-body tight' },
              h('p', { class: 'muted small', style: { margin: '0 12px 8px' } }, t('legacyPaymentHint')),
              paymentsTable(invoice, data.rows, refresh))));
      } catch (error) {
        toastError(error);
        mount(body, h('div', { class: 'empty' }, error.message));
      }
    }

    refresh();
    return dialog;
  }

  /**
   * The pages of the invoice, big enough to recognise, each opening the
   * readable original — plus adding a page he forgot and removing one he
   * photographed twice. Both go through the generic attachment endpoints: the
   * owner type was registered by the service, so this screen needed no routes
   * of its own.
   */
  function photoStrip(invoice, refresh) {
    const pickerHost = h('div');

    const addPage = () => {
      /*
       * Pages chosen from the gallery beyond the first. They are prepared the
       * moment they are picked and held here until Save, so the person sees a
       * count that matches what they selected rather than discovering
       * afterwards that only one of the four went up.
       */
      const extras = [];
      const extraNote = h('span', { class: 'muted small' });

      const picker = proofPicker({
        hint: t('invoicePhotosHint'),
        alt: t('invoicePhotos'),
        multiple: true,
        onExtra: async (files) => {
          for (const file of files) {
            // eslint-disable-next-line no-await-in-loop -- one canvas at a time
            // on a phone; four at once is four full-size decodes in memory.
            const prepared = await preparePhoto(file).catch((error) => {
              toast(error.message, 'error', 6000);
              return null;
            });
            if (prepared) extras.push(prepared);
          }
          extraNote.textContent = extras.length
            ? photoCountLabel(extras.length + 1)
            : '';
        },
      });

      mount(pickerHost, h('div', { class: 'stack' },
        picker.node,
        h('div', { class: 'row-actions' },
          h('button', {
            class: 'btn sm primary',
            onclick: async (event) => {
              const photo = picker.value();
              if (picker.isBusy()) { toast(t('preparingPhoto'), 'warn'); return; }
              if (!photo) { toast(t('invoicePhotoNeeded'), 'warn'); return; }
              event.currentTarget.disabled = true;
              try {
                // One at a time: each is its own attachment, and a shop's
                // connection does not thank anybody for four parallel uploads.
                for (const page of [photo, ...extras]) {
                  // eslint-disable-next-line no-await-in-loop
                  await api.post(`/api/attachments/legacy_invoice/${invoice.id}`, page);
                }
                toast(t('invoicePhotoAdded'));
                mount(pickerHost);
                refresh();
              } catch (error) { toastError(error); event.currentTarget.disabled = false; }
            },
          }, t('save')),
          extraNote,
          h('button', { class: 'btn sm ghost', onclick: () => mount(pickerHost) }, t('cancel')))));
    };

    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h3', {}, `${t('invoicePhotos')} · ${photoCountLabel(invoice.attachments.length)}`),
        h('span', { class: 'spacer' }),
        can('legacy_invoices.update')
          ? h('button', { class: 'btn sm', onclick: addPage }, `＋ ${t('addAnotherPhoto')}`)
          : null),
      h('div', { class: 'card-body tight' },
        h('div', { class: 'proof-picker' }, invoice.attachments.map((attachment) => h('div', { class: 'stack', style: { gap: '4px' } },
          h('img', {
            class: 'proof-thumb',
            loading: 'lazy',
            src: proofUrl(attachment.id, 'thumb'),
            alt: t('invoicePhotos'),
            title: t('openFullSize'),
            onclick: () => openProof(attachment, invoiceCaption(invoice)),
          }),
          can('legacy_invoices.update')
            ? h('button', {
              class: 'btn sm ghost',
              title: t('removePhoto'),
              onclick: async () => {
                const ok = await confirmDialog({
                  title: t('removePhoto'), message: t('invoiceRemovePhotoConfirm'),
                  danger: true, confirmLabel: t('removePhoto'),
                });
                if (!ok) return;
                try {
                  await api.del(`/api/attachments/${attachment.id}`);
                  toast(t('invoicePhotoRemoved'));
                  refresh();
                } catch (error) { toastError(error); }
              },
            }, '✕')
            : null))),
        pickerHost));
  }

  function paymentsTable(invoice, rows, refresh) {
    return dataTable({
      columns: [
        {
          key: 'paid_on',
          label: t('paidOnDate'),
          render: (p) => h('div', {},
            h('div', {}, date(p.paid_on)),
            p.status === 'reversed' ? tag(t('reversedPayment'), 'danger') : null),
        },
        { key: 'amount', label: t('amount'), type: 'money', class: 'amount', render: (p) => money(p.amount) },
        {
          key: 'method',
          label: t('paymentMethod'),
          render: (p) => t(p.method === 'unknown' ? 'unknownMethod' : p.method, p.method),
        },
        { key: 'reference', label: t('paymentReference'), class: 'mono small' },
        {
          key: 'note',
          label: t('paymentNote'),
          render: (p) => h('div', {},
            h('div', {}, p.note || '—'),
            p.status === 'reversed'
              ? h('small', { class: 'muted' },
                `${t('reversedBy')}: ${p.reversed_by_name || '—'} — ${p.reversal_reason || ''}`)
              : null),
        },
        { key: 'created_by_name', label: t('recordedBy') },
        {
          key: 'proof',
          label: t('proof'),
          render: (p) => proofThumbs(p.attachments, `${invoice.title} — ${money(p.amount)}`),
        },
        {
          key: '__actions',
          label: t('actions'),
          class: 'nowrap',
          render: (p) => (can('legacy_invoices.reverse_payment') && p.status === 'recorded'
            ? h('button', {
              class: 'btn sm ghost',
              title: t('reversePayment'),
              onclick: () => openReversal(invoice, p, refresh),
            }, '↺')
            : ''),
        },
      ],
      rows,
      rowClass: (p) => (p.status === 'reversed' ? 'payment-reversed' : ''),
      emptyMessage: t('noPaymentsYet'),
    });
  }

  /**
   * A payment that was wrong is REVERSED, never deleted — the row stays,
   * struck through, with who reversed it and why, and the total and the status
   * drop back on their own because both are derived from the rows that are
   * still recorded. See LegacyInvoiceService for the reasoning.
   */
  function openReversal(invoice, payment, refresh) {
    const reason = textInput({ placeholder: t('mistypedAmount') });
    const dialog = modal({
      title: `${t('reversePayment')} — ${money(payment.amount)}`,
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'muted small' }, t('reversalReasonHint')),
        field({ label: t('reversalReason'), input: reason })),
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn danger',
          onclick: async () => {
            if (!reason.value.trim()) { toast(t('reversalReason'), 'warn'); return; }
            try {
              await api.post(
                `/api/legacy-invoices/${invoice.id}/payments/${payment.id}/reverse`,
                { reason: reason.value.trim() },
              );
              toast(t('paymentReversed'));
              dialog.close();
              refresh();
              load();
            } catch (error) { toastError(error); }
          },
        }, t('reversePayment')),
      ],
    });
  }

  function openPayment(invoice, refresh) {
    // What is left, offered as the default — "ادفع الباقي" is what he does most
    // of the time. An invoice with no total yet has nothing to suggest, so the
    // box opens empty rather than with a confident zero in it.
    const rest = invoice.outstanding === null || invoice.outstanding <= 0 ? '' : invoice.outstanding;
    const form = buildForm([
      { name: 'amount', label: t('amount'), type: 'number', required: true, value: rest },
      { name: 'paidOn', label: t('paidOnDate'), type: 'date', required: true },
      {
        name: 'method',
        label: t('paymentMethod'),
        type: 'select',
        required: true,
        options: METHODS.map((m) => ({ value: m, label: t(m) })),
      },
      { name: 'reference', label: t('paymentReference') },
      { name: 'note', label: t('paymentNote'), span: 2 },
      // Required and empty, for the same reason the invoice date is: these
      // payments were usually made years ago.
    ], { method: 'cash' }, { columns: 2 });

    const proof = proofPicker({ hint: t('legacyProofHint'), alt: t('proofOfPayment') });

    const dialog = modal({
      title: `${t('registerPayment')} — ${invoice.title}`,
      size: 'narrow',
      body: h('div', { class: 'stack' },
        h('div', { class: 'muted small' }, t('legacyPaymentHint')),
        h('div', { class: 'muted small' }, invoice.outstanding === null
          ? t('invoiceUnknownHint')
          : `${t('stillOwed')}: ${money(invoice.outstanding)}`),
        form.node,
        field({ label: t('proofOfPayment'), input: proof.node, hint: t('legacyProofHint') })),
      footer: [
        h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            if (!form.validate()) return;
            if (proof.isBusy()) { toast(t('preparingPhoto'), 'warn'); return; }
            const values = form.values();
            try {
              await api.post(`/api/legacy-invoices/${invoice.id}/payments`, {
                // Sent as typed and rounded by the server; nothing the browser
                // calculated is trusted as a total.
                amount: Number(values.amount),
                method: values.method,
                reference: values.reference || null,
                note: values.note || null,
                paidOn: values.paidOn || null,
                photo: proof.value(),
              });
              toast(t('paymentRecorded'));
              dialog.close();
              refresh();
              load();
            } catch (error) { toastError(error); }
          },
        }, t('save')),
      ],
    });
  }

  // --------------------------------------------------------------- shell

  const setFilter = (key, value) => { state.filters[key] = value; state.page = 1; load(); };

  const filterBar = () => h('div', { class: 'filters' },
    h('div', { class: 'field grow' }, textInput({
      placeholder: t('searchInvoicesHint'),
      value: state.filters.search,
      oninput: debounce((event) => setFilter('search', event.target.value), 280),
    })),
    h('div', { class: 'field' }, field({
      label: t('supplier'),
      input: selectInput({
        placeholder: t('all'),
        value: state.filters.supplierId,
        options: suppliers.map((s) => ({ value: s.id, label: pick(s, 'name') })),
        onchange: (event) => setFilter('supplierId', event.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('status'),
      input: selectInput({
        placeholder: t('anyStatus'),
        value: state.filters.status,
        options: STATUSES.map((s) => ({ value: s, label: t(STATUS_TAG[s][0]) })),
        onchange: (event) => setFilter('status', event.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('from'),
      input: h('input', {
        class: 'input', type: 'date', value: state.filters.dateFrom,
        onchange: (event) => setFilter('dateFrom', event.target.value),
      }),
    })),
    h('div', { class: 'field' }, field({
      label: t('to'),
      input: h('input', {
        class: 'input', type: 'date', value: state.filters.dateTo,
        onchange: (event) => setFilter('dateTo', event.target.value),
      }),
    })),
    h('div', { class: 'field' }, checkboxInput({
      label: t('outstandingOnly'),
      checked: state.filters.outstandingOnly,
      onchange: (event) => setFilter('outstandingOnly', event.target.checked),
    })));

  mount(root,
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', {}, t('legacyInvoices')),
        h('p', {}, t('legacyInvoicesSubtitle'))),
      h('span', { class: 'spacer' }),
      can('legacy_invoices.create')
        ? h('button', { class: 'btn primary', onclick: () => openForm(null) }, `＋ ${t('newLegacyInvoice')}`)
        : null),
    // The sentence that keeps this page and the shop's accounts apart, in his
    // own language, permanently on screen rather than in a tooltip.
    h('div', { class: 'callout' },
      h('strong', {}, `${t('outsideTheAccounts')}. `),
      t('legacyInvoicesNotice')),
    kpiHost,
    h('div', { class: 'card' }, filterBar(), listHost, pagerHost));

  load();
}

export default legacyInvoicesView;

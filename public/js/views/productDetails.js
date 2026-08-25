/**
 * Product details — the read-only view of a product.
 *
 * Answers the four questions someone actually opens a product to ask:
 *   what is it, what is on the shelf right now, is it making money, and
 *   where has it been. Editing lives on a separate screen so looking something
 *   up during a busy hour can never accidentally change it.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, spinner, tag, toast, toastError, modal, printNode,
  selectInput, numberInput, buildForm,
} from '../core/ui.js';
import { t, pick, getLanguage } from '../core/i18n.js';
import { money, number, percent, date, dateTime } from '../core/format.js';
import { can, devices } from '../core/store.js';
import { navigate } from '../core/router.js';
import { labelCard } from './labels.js';
import { confirmDelete } from './trash.js';

export async function productDetailsView(root, productId) {
  mount(root, spinner());
  let data = await api.get(`/api/products/${productId}/overview`);

  const reload = async () => {
    data = await api.get(`/api/products/${productId}/overview`);
    render();
  };

  function render() {
    const p = data.product;
    const totals = data.totals;
    const perf = data.performance;

    const status = [];
    if (!p.is_active) status.push(tag(t('inactive')));
    if (totals.outCount) status.push(tag(`${totals.outCount} ${t('outOfStock')}`, 'danger'));
    if (totals.lowCount) status.push(tag(`${totals.lowCount} ${t('lowStockItems')}`, 'warn'));
    if (!status.length) status.push(tag(t('active'), 'ok'));

    mount(root,
      // ---------------------------------------------------------- header
      h('div', { class: 'page-head' },
        h('div', {},
          h('h2', {}, pick(p, 'name')),
          h('p', {},
            h('span', { class: 'mono' }, p.sku_prefix),
            [p.brand_name_en, p.category_name_en].filter(Boolean).length
              ? ` · ${[p.brand_name_en, p.category_name_en].filter(Boolean).join(' · ')}`
              : '')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => navigate('products') }, '‹ ' + t('products')),
        can('labels.print')
          ? h('button', { class: 'btn', onclick: () => openLabelDialog(data) }, '▩ ' + t('printLabels'))
          : null,
        can('products.update')
          ? h('button', { class: 'btn primary', onclick: () => navigate(`products/${productId}/edit`) }, '✎ ' + t('edit'))
          : null),

      h('div', { class: 'row', style: { marginBottom: '14px' } }, ...status,
        p.tags ? p.tags.split(',').filter(Boolean).map((x) => tag(x.trim(), 'info')) : null),

      // ------------------------------------------------------------- KPIs
      h('div', { class: 'kpis' },
        kpi(t('onHand'), number(totals.quantity), `${totals.variantCount} ${t('variants')}`, true),
        kpi(t('stockValue'), money(totals.stockValue), t('atCost')),
        kpi(t('retailValue'), money(totals.retailValue), `${t('potentialMargin')}: ${money(totals.potentialMargin)}`),
        kpi(t('priceRange'), totals.minPrice === totals.maxPrice
          ? money(totals.minPrice)
          : `${money(totals.minPrice)} – ${money(totals.maxPrice)}`, `${t('taxRate')} ${number(p.tax_rate)}%`),
        kpi(`${t('unitsSold')} · ${perf.windowDays}${t('dayShort')}`, number(perf.units), `${perf.invoices} ${t('invoice')}`),
        kpi(t('revenue'), money(perf.revenue), `${t('profit')}: ${money(perf.profit)}`),
        kpi(t('margin'), percent(perf.margin_percent), t('onSalesInPeriod')),
        kpi(t('lastSold'), perf.last_sold ? date(perf.last_sold) : t('neverSold'),
          perf.returned_units ? `${number(perf.returned_units)} ${t('returned')}` : '')),

      // -------------------------------------------------------- identity
      h('div', { class: 'grid cols-3', style: { marginTop: '16px', alignItems: 'start' } },
        h('div', { class: 'card', style: { gridColumn: 'span 2' } },
          h('div', { class: 'card-head' }, h('h3', {}, t('details'))),
          h('div', { class: 'card-body' },
            h('div', { class: 'grid cols-3' },
              detail(t('nameEn'), p.name_en),
              detail(t('nameAr'), p.name_ar),
              detail(t('skuPrefix'), h('span', { class: 'mono' }, p.sku_prefix)),
              detail(t('brand'), p.brand_name_en),
              detail(t('category'), p.category_name_en),
              detail(t('supplier'), p.supplier_id && can('suppliers.view')
                ? h('a', {
                  href: '#/suppliers',
                  style: { color: 'var(--accent)' },
                }, p.supplier_name_en)
                : p.supplier_name_en),
              detail(t('unit'), p.unit),
              detail(t('taxRate'), `${number(p.tax_rate)}%`),
              detail(t('trackInventory'), p.track_inventory ? t('yes') : t('no')),
              detail(t('createdAt'), date(p.created_at)),
              detail(t('updatedAt'), date(p.updated_at)),
              detail(t('attributes'), data.attributes.length
                ? data.attributes.map((a) => pick(a, 'name')).join(', ')
                : t('none'))),
            pick(p, 'description')
              ? h('div', { style: { marginTop: '14px' } },
                h('div', { class: 'small strong' }, t('description')),
                h('p', { class: 'muted', style: { margin: '4px 0 0' } }, pick(p, 'description')))
              : null)),

        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, t('quickActions'))),
          h('div', { class: 'card-body stack' },
            can('sales.create')
              ? h('button', { class: 'btn gold block', onclick: () => navigate('pos') }, t('sellThis'))
              : null,
            can('purchases.create')
              ? h('button', { class: 'btn block', onclick: () => reorderFrom(data) }, t('reorderThis'))
              : null,
            can('inventory.view')
              ? h('button', {
                class: 'btn block',
                onclick: () => navigate(`movements?variantId=${data.variants[0]?.id || ''}`),
              }, t('viewMovements'))
              : null,
            can('labels.print')
              ? h('button', { class: 'btn block', onclick: () => openLabelDialog(data) }, t('printLabels'))
              : null,
            can('products.delete')
              ? h('button', {
                class: 'btn block danger',
                onclick: () => confirmDelete({
                  entityType: 'product',
                  entityId: productId,
                  onDone: () => navigate('products'),
                }),
              }, t('delete'))
              : null))),

      // -------------------------------------------------------- variants
      h('div', { class: 'card', style: { marginTop: '16px' } },
        h('div', { class: 'card-head' },
          h('h3', {}, t('variants')),
          h('span', { class: 'spacer' }),
          h('span', { class: 'muted small' },
            `${totals.activeVariantCount} / ${totals.variantCount} ${t('active').toLowerCase()}`)),
        h('div', { class: 'card-body tight' }, dataTable({
          columns: [
            { key: 'sku', label: t('sku'), class: 'mono small' },
            {
              key: 'variant',
              label: t('variant'),
              render: (v) => h('div', { class: 'row', style: { gap: '6px' } },
                ...(v.options || []).map((o) => (o.color_hex
                  ? h('span', { class: 'swatch', style: { background: o.color_hex }, title: pick(o, 'value') })
                  : null)),
                h('span', { class: 'strong small' }, variantLabel(v))),
            },
            { key: 'barcode', label: t('barcode'), class: 'mono small' },
            { key: 'cost_price', label: t('costPrice'), type: 'money', render: (v) => money(v.cost_price) },
            { key: 'selling_price', label: t('sellingPrice'), type: 'money', render: (v) => h('span', { class: 'strong' }, money(v.selling_price)) },
            { key: 'wholesale_price', label: t('wholesalePrice'), type: 'money', render: (v) => money(v.wholesale_price) },
            { key: 'margin_percent', label: t('margin'), type: 'percent', render: (v) => percent(v.margin_percent) },
            {
              key: 'quantity',
              label: t('onHand'),
              type: 'number',
              render: (v) => h('span', {
                class: v.is_out ? 'tag danger' : (v.is_low ? 'tag warn' : 'strong'),
              }, number(v.quantity)),
            },
            { key: 'reorder_level', label: t('reorderLevel'), type: 'number', render: (v) => number(v.reorder_level) },
            { key: 'stock_value', label: t('value'), type: 'money', render: (v) => money(v.stock_value) },
            {
              key: '__a',
              label: '',
              width: '1%',
              render: (v) => h('div', { class: 'row nowrap', style: { gap: '4px', justifyContent: 'flex-end' } },
                h('button', { class: 'btn sm ghost', title: t('showQr'), onclick: () => showVariantQr(v, data) }, '▣'),
                can('inventory.adjust')
                  ? h('button', { class: 'btn sm ghost', title: t('adjustStock'), onclick: () => adjustVariant(v, reload) }, '⇅')
                  : null,
                can('inventory.view')
                  ? h('button', {
                    class: 'btn sm ghost', title: t('movements'),
                    onclick: () => navigate(`movements?variantId=${v.id}`),
                  }, '≡')
                  : null),
            },
          ],
          rows: data.variants,
          rowClass: (v) => (v.is_active ? '' : 'muted'),
          footer: h('tr', {},
            h('td', { colspan: 7, class: 'right' }, t('total')),
            h('td', { class: 'num' }, number(totals.quantity)),
            h('td', {}),
            h('td', { class: 'num' }, money(totals.stockValue)),
            h('td', {})),
        }))),

      // --------------------------------------------------------- history
      historyCard(t('salesHistory'), data.sales, [
        { key: 'invoice_no', label: t('invoiceNo'), class: 'mono small' },
        { key: 'sale_date', label: t('date'), render: (r) => h('span', { class: 'small' }, dateTime(r.sale_date)) },
        { key: 'customer_name', label: t('customer') },
        { key: 'sku', label: t('sku'), class: 'mono small' },
        { key: 'quantity', label: t('qty'), type: 'number', render: (r) => number(r.quantity) },
        { key: 'returned_quantity', label: t('returned'), type: 'number', render: (r) => (r.returned_quantity ? number(r.returned_quantity) : '—') },
        { key: 'unit_price', label: t('price'), type: 'money', render: (r) => money(r.unit_price) },
        { key: 'line_total', label: t('total'), type: 'money', render: (r) => money(r.line_total) },
        { key: 'status', label: t('status'), render: (r) => (r.status === 'void' ? tag(t('void'), 'danger') : tag(t('completed'), 'ok')) },
      ], can('sales.view') ? (row) => navigate(`sales/${row.sale_id}`) : null),

      historyCard(t('purchaseHistory'), data.purchases, [
        { key: 'po_number', label: t('poNumber'), class: 'mono small' },
        { key: 'order_date', label: t('date'), render: (r) => date(r.order_date) },
        { key: 'supplier_name', label: t('supplier') },
        { key: 'sku', label: t('sku'), class: 'mono small' },
        { key: 'quantity_ordered', label: t('ordered'), type: 'number', render: (r) => number(r.quantity_ordered) },
        { key: 'quantity_received', label: t('received'), type: 'number', render: (r) => number(r.quantity_received) },
        { key: 'unit_cost', label: t('unitCost'), type: 'money', render: (r) => money(r.unit_cost) },
        { key: 'status', label: t('status'), render: (r) => tag(r.status.replace(/_/g, ' ')) },
      ], can('purchases.view') ? (row) => navigate(`purchases/${row.purchase_order_id}`) : null),

      data.returns.length
        ? historyCard(t('returns'), data.returns, [
          { key: 'return_no', label: t('document'), class: 'mono small' },
          { key: 'return_date', label: t('date'), render: (r) => dateTime(r.return_date) },
          { key: 'sku', label: t('sku'), class: 'mono small' },
          { key: 'quantity', label: t('qty'), type: 'number', render: (r) => number(r.quantity) },
          {
            key: 'condition',
            label: t('condition'),
            render: (r) => (r.condition === 'damaged'
              ? tag(t('damaged'), 'danger') : tag(t('resellable'), 'ok')),
          },
          { key: 'reason_code', label: t('reason') },
          { key: 'line_total', label: t('refunded'), type: 'money', render: (r) => money(r.line_total) },
        ], can('sales.view') ? (row) => navigate(`returns/${row.return_id}`) : null)
        : null,

      historyCard(t('movements'), data.movements, [
        { key: 'created_at', label: t('date'), render: (r) => h('span', { class: 'small' }, dateTime(r.created_at)) },
        { key: 'reference_no', label: t('document'), class: 'mono small', render: (r) => r.reference_no || '—' },
        {
          key: 'movement_type',
          label: t('movementType'),
          render: (r) => tag(r.movement_type.replace(/_/g, ' '), r.quantity > 0 ? 'ok' : 'warn'),
        },
        { key: 'sku', label: t('sku'), class: 'mono small' },
        {
          key: 'quantity',
          label: t('qty'),
          type: 'number',
          render: (r) => h('span', { class: 'strong' }, `${r.quantity > 0 ? '+' : ''}${number(r.quantity)}`),
        },
        { key: 'balance_after', label: t('balanceAfter'), type: 'number', render: (r) => number(r.balance_after) },
        { key: 'user_name', label: t('user'), render: (r) => h('span', { class: 'small muted' }, r.user_name || '—') },
      ]));
  }

  render();
  return undefined;
}

// ------------------------------------------------------------------ helpers

const kpi = (label, value, sub, accent) => h('div', { class: `kpi${accent ? ' accent' : ''}` },
  h('div', { class: 'label' }, label),
  h('div', { class: 'value' }, value),
  sub ? h('div', { class: 'sub' }, sub) : null);

const detail = (label, value) => h('div', {},
  h('div', { class: 'label small muted' }, label),
  h('div', { class: 'strong' }, value || '—'));

const variantLabel = (variant) => {
  if (variant.options?.length) {
    return variant.options.map((o) => pick(o, 'value')).join(' / ');
  }
  return variant.variant_label || 'Default';
};

function historyCard(title, rows, columns, onRowClick) {
  return h('div', { class: 'card', style: { marginTop: '16px' } },
    h('div', { class: 'card-head' },
      h('h3', {}, title),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, `${rows.length} ${t('results')}`)),
    h('div', { class: 'card-body tight' }, dataTable({ columns, rows, onRowClick })));
}

/** Shows the printable QR for one variant, at the size configured in Devices. */
async function showVariantQr(variant, data) {
  const cfg = devices().label;
  const payload = variant.barcode || variant.sku;
  const holder = h('div', { class: 'center' }, spinner());

  const dialog = modal({
    title: `${t('barcode')} — ${variant.sku}`,
    size: 'narrow',
    body: h('div', { class: 'stack center' },
      holder,
      h('div', { class: 'mono strong', style: { fontSize: '15px' } }, payload),
      h('div', { class: 'muted small' }, t('qrPayloadHint'))),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('close')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const label = await buildLabel(variant, data);
          printNode(h('div', { class: 'label-sheet' }, labelCard(label, cfg)));
        },
      }, '🖨 ' + t('print')),
    ],
  });

  try {
    const { dataUri } = await api.get('/api/labels/qr', { payload, size: 220 });
    mount(holder, h('img', { src: dataUri, alt: payload, style: { width: '190px' } }));
  } catch (error) {
    toastError(error);
    mount(holder, h('div', { class: 'empty' }, t('somethingWrong')));
  }
}

async function buildLabel(variant, data) {
  const { dataUri } = await api.get('/api/labels/qr', { payload: variant.barcode || variant.sku, size: 180 });
  return {
    sku: variant.sku,
    barcode: variant.barcode || variant.sku,
    qr: dataUri,
    productNameEn: data.product.name_en,
    productNameAr: data.product.name_ar,
    variantLabel: variantLabel(variant),
    price: variant.selling_price,
    currency: 'EGP',
    company: { name: data.product.brand_name_en },
  };
}

/** Print labels for the whole product — one row per variant, copies you choose. */
function openLabelDialog(data) {
  const items = data.variants
    .filter((v) => v.is_active)
    .map((v) => ({ variant_id: v.id, sku: v.sku, label: variantLabel(v), price: v.selling_price, copies: 1 }));

  const host = h('div');
  const render = () => mount(host, dataTable({
    columns: [
      { key: 'sku', label: t('sku'), class: 'mono small' },
      { key: 'label', label: t('variant') },
      { key: 'price', label: t('price'), type: 'money', render: (r) => money(r.price) },
      {
        key: 'copies',
        label: t('copies'),
        align: 'end',
        render: (r) => numberInput({
          value: r.copies, min: 0, max: 200, style: { width: '82px' },
          onchange: (e) => { r.copies = Math.max(0, Number(e.target.value) || 0); render(); },
        }),
      },
    ],
    rows: items,
    footer: h('tr', {},
      h('td', { colspan: 3, class: 'right' }, t('total')),
      h('td', { class: 'num' }, `${items.reduce((s, i) => s + i.copies, 0)} ${t('labelsQueued')}`)),
  }));

  const dialog = modal({
    title: `${t('printLabels')} — ${data.product.sku_prefix}`,
    size: 'wide',
    body: h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, t('labelCountHint')),
      host),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const chosen = items.filter((i) => i.copies > 0);
          if (!chosen.length) { toast(t('labelCountHint'), 'warn'); return; }
          try {
            const cfg = devices().label;
            const batch = await api.post('/api/labels/batch', {
              items: chosen.map((i) => ({ variant_id: i.variant_id, copies: i.copies })),
              labelSize: `${cfg.widthMm}x${cfg.heightMm}`,
              qrSize: 180,
            });
            printNode(h('div', { class: 'label-sheet' }, batch.labels.map((l) => labelCard(l, cfg))));
            dialog.close();
          } catch (error) { toastError(error); }
        },
      }, '🖨 ' + t('printSheet')),
    ],
  });
  render();
}

function adjustVariant(variant, refresh) {
  const form = buildForm([
    { name: 'newQuantity', label: t('newQuantity'), type: 'number', required: true, value: variant.quantity },
    {
      name: 'reason',
      label: t('reason'),
      type: 'select',
      required: true,
      options: ['correction', 'damage', 'loss', 'theft', 'expiry', 'other'].map((v) => ({ value: v, label: t(v) })),
    },
    { name: 'notes', label: t('notes'), type: 'textarea', span: 2 },
  ], { reason: 'correction' }, { columns: 2 });

  const dialog = modal({
    title: `${t('adjustStock')} — ${variant.sku}`,
    size: 'narrow',
    body: h('div', { class: 'stack' },
      h('div', { class: 'muted small' }, `${t('onHand')}: ${number(variant.quantity)}`),
      form.node),
    footer: [
      h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          if (!form.validate()) return;
          try {
            await api.post('/api/inventory/quick-adjust', { ...form.values(), variantId: variant.id });
            toast(t('saved'));
            dialog.close();
            refresh();
          } catch (error) { toastError(error); }
        },
      }, t('save')),
    ],
  });
}

/** Send the low variants of this product straight into a new purchase order. */
function reorderFrom(data) {
  const group = {
    supplier_id: data.product.supplier_id,
    supplier_name: data.product.supplier_name_en,
    lines: data.variants
      .filter((v) => v.is_active)
      .map((v) => ({
        variant_id: v.id,
        sku: v.sku,
        product_name_en: data.product.name_en,
        variant_label: variantLabel(v),
        on_hand: v.quantity,
        reorder_level: v.reorder_level,
        quantity_ordered: Math.max(v.reorder_quantity || 0, v.reorder_level - v.quantity, 1),
        unit_cost: v.cost_price,
      })),
  };
  sessionStorage.setItem('mm.reorder', JSON.stringify(group));
  navigate('purchases/new');
}

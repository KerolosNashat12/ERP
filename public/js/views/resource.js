/**
 * Generic list + create/edit screen for any CRUD resource.
 * Suppliers, brands, categories, clients, promotions and users are all this
 * one component with a different configuration — the UI equivalent of the
 * CrudService on the server.
 */
import api from '../core/api.js';
import {
  h, mount, dataTable, pager, spinner, buildForm, modal, toast, toastError,
  confirmDialog, debounce, textInput, summaryCards,
} from '../core/ui.js';
import { t } from '../core/i18n.js';
import { can, invalidate } from '../core/store.js';
import { confirmDelete } from './trash.js';

export function resourceView(config) {
  return async function view(root, route) {
    const state = {
      search: route.query.search || '',
      page: Number(route.query.page) || 1,
      pageSize: 25,
      extra: {},
      data: null,
    };

    const listHost = h('div', { class: 'card-body tight' }, spinner());
    const pagerHost = h('div');
    const cardsHost = h('div');

    /*
     * Optional counters above the list. A screen that wants them declares
     * `summary(counts, state, reload)` and returns cards; a screen that does not
     * is unchanged, and one whose endpoint is missing or refuses simply draws
     * the list as before rather than failing on a header.
     */
    async function loadSummary() {
      if (!config.summary || !config.summaryEndpoint) return;
      try {
        const counts = await api.get(config.summaryEndpoint, {});
        mount(cardsHost, summaryCards(config.summary(counts, state, load)));
      } catch { mount(cardsHost); }
    }

    async function load() {
      mount(listHost, spinner());
      try {
        const [data] = await Promise.all([
          api.get(config.endpoint, {
            search: state.search, page: state.page, pageSize: state.pageSize, ...state.extra,
          }),
          loadSummary(),
        ]);
        state.data = data;
        renderTable(data);
      } catch (error) {
        toastError(error);
        mount(listHost, h('div', { class: 'empty' }, error.message));
      }
    }

    function renderTable(data) {
      const rows = data.rows || [];
      const columns = [...config.columns(refresh)];
      if (config.canEdit !== false && (can(`${config.module}.update`) || can(`${config.module}.delete`))) {
        columns.push({
          key: '__actions',
          label: '',
          width: '1%',
          render: (row) => h('div', { class: 'row nowrap', style: { gap: '4px', justifyContent: 'flex-end' } },
            ...(config.rowActions ? config.rowActions(row, refresh) : []),
            can(`${config.module}.update`)
              ? h('button', { class: 'btn sm ghost', title: t('edit'), onclick: () => openForm(row) }, '✎')
              : null,
            can(`${config.module}.delete`)
              ? h('button', {
                class: 'btn sm ghost',
                title: t('delete'),
                onclick: async () => {
                  /*
                   * A resource that has a place in the recycle bin goes there,
                   * through the one dialog that first asks the server what
                   * deleting it would actually do — what depends on it, what it
                   * would cost, and how long there is to change your mind.
                   *
                   * Anything without a `trashType` keeps the old straight
                   * delete: those are rows the bin has no policy for, and a
                   * delete with no policy behind it must not pretend to be
                   * reversible.
                   */
                  if (config.trashType) {
                    await confirmDelete({
                      entityType: config.trashType, entityId: row.id, onDone: refresh,
                    });
                    return;
                  }
                  const ok = await confirmDialog({
                    title: t('delete'), message: t('deleteConfirm'), danger: true, confirmLabel: t('delete'),
                  });
                  if (!ok) return;
                  try {
                    const result = await api.del(`${config.endpoint}/${row.id}`);
                    toast(result?.deactivated ? `${t('saved')} (${t('inactive')})` : t('deleted'));
                    refresh();
                  } catch (error) { toastError(error); }
                },
              }, '🗑')
              : null),
        });
      }

      mount(listHost, dataTable({
        columns,
        rows,
        onRowClick: config.onRowClick,
        rowClass: config.rowClass,
        emptyMessage: config.emptyMessage,
      }));
      mount(pagerHost, pager({
        page: data.page, pages: data.pages, total: data.total,
        onPage: (p) => { state.page = p; load(); },
      }));
    }

    function refresh() {
      invalidate();
      load();
    }

    async function openForm(record = null) {
      const fields = await config.fields(record);
      const initial = record ? { ...record } : (config.defaults || {});
      const form = buildForm(fields, initial, { columns: config.formColumns || 2 });
      const extraNode = config.formExtra ? await config.formExtra(record, form) : null;

      const dialog = modal({
        title: record ? `${t('edit')} — ${config.label(record)}` : (config.createLabel || t('create')),
        size: config.formSize || '',
        body: h('div', { class: 'stack' }, form.node, extraNode),
        footer: [
          h('button', { class: 'btn', onclick: () => dialog.close() }, t('cancel')),
          h('button', {
            class: 'btn primary',
            onclick: async (event) => {
              if (!form.validate()) return;
              const button = event.currentTarget;
              button.disabled = true;
              try {
                let payload = form.values();
                if (config.beforeSubmit) payload = await config.beforeSubmit(payload, record, form);
                if (record) await api.put(`${config.endpoint}/${record.id}`, payload);
                else await api.post(config.endpoint, payload);
                toast(t('saved'));
                dialog.close();
                refresh();
              } catch (error) {
                if (error.details?.length) form.setErrors(error.details);
                toastError(error);
              } finally {
                button.disabled = false;
              }
            },
          }, t('save')),
        ],
      });
    }

    const searchBox = textInput({
      value: state.search,
      placeholder: t('search'),
      oninput: debounce((event) => { state.search = event.target.value; state.page = 1; load(); }, 280),
    });

    const filterBar = h('div', { class: 'filters' },
      h('div', { class: 'field grow' }, searchBox),
      ...(config.filters ? config.filters(state, load) : []),
      h('button', { class: 'btn sm', onclick: () => { state.search = ''; searchBox.value = ''; state.extra = {}; state.page = 1; load(); } }, t('reset')));

    mount(root,
      h('div', { class: 'page-head' },
        h('div', {}, h('h2', {}, config.title), config.subtitle ? h('p', {}, config.subtitle) : null),
        h('span', { class: 'spacer' }),
        ...(config.headerActions ? config.headerActions(refresh) : []),
        can(`${config.module}.create`)
          ? h('button', { class: 'btn primary', onclick: () => openForm(null) }, '＋ ' + (config.createLabel || t('create')))
          : null),
      cardsHost,
      h('div', { class: 'card' }, filterBar, listHost, pagerHost));

    await load();
    if (route.segments[1] === 'new' && can(`${config.module}.create`)) openForm(null);
  };
}

/** Convenience: turns a rows array into <select> options. */
export const toOptions = (rows, labelFn, valueKey = 'id') =>
  rows.map((row) => ({ value: row[valueKey], label: labelFn(row) }));

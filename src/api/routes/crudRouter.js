/**
 * Builds a standard REST router for any CrudService.
 * GET /  GET /options  GET /:id  POST /  PUT /:id  DELETE /:id
 */
import { Router } from 'express';
import { asyncHandler, requirePermission, validate } from '../middleware/index.js';

export function crudRouter({ service, module, schema, updateSchema, extend }) {
  const router = Router();
  const perm = (action) => requirePermission(`${module}.${action}`);

  router.get('/', perm('view'), asyncHandler((req, res) => {
    res.json(service.list({
      search: req.query.search,
      page: req.query.page,
      pageSize: req.query.pageSize,
      sort: req.query.sort,
      order: req.query.order,
      all: req.query.all,
      filters: req.query.is_active !== undefined ? { is_active: Number(req.query.is_active) } : {},
    }));
  }));

  router.get('/options', perm('view'), asyncHandler((_req, res) => {
    res.json({ rows: service.options() });
  }));

  if (extend) extend(router, { perm, service });

  router.get('/:id', perm('view'), asyncHandler((req, res) => {
    res.json(service.get(Number(req.params.id)));
  }));

  router.post('/', perm('create'), validate(schema), asyncHandler((req, res) => {
    res.status(201).json(service.create(req.body, req.context));
  }));

  router.put('/:id', perm('update'), validate(updateSchema || schema.partial()), asyncHandler((req, res) => {
    res.json(service.update(Number(req.params.id), req.body, req.context));
  }));

  router.delete('/:id', perm('delete'), asyncHandler((req, res) => {
    res.json(service.remove(Number(req.params.id), req.context));
  }));

  return router;
}

export default crudRouter;

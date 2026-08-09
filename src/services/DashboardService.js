/** KPI tiles, trend series and alert feeds for the home screen. */
import repositories from '../infrastructure/repositories/index.js';
import { getDb } from '../infrastructure/database/connection.js';
import { round2 } from '../shared/money.js';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

export class DashboardService {
  overview({ warehouseId = null } = {}) {
    const db = getDb();
    const sales = repositories.sales;

    const todayTotals = sales.salesTotals({ dateFrom: today(), dateTo: today(), warehouseId });
    const monthTotals = sales.salesTotals({ dateFrom: today().slice(0, 8) + '01', dateTo: today(), warehouseId });
    const week = sales.salesTotals({ dateFrom: daysAgo(6), dateTo: today(), warehouseId });
    const stock = repositories.inventory.totalStockValue(warehouseId);

    const trend = db.prepare(`
      SELECT date(sale_date) AS day,
             ROUND(SUM(total_amount),2) AS revenue,
             ROUND(SUM(total_amount - total_cost),2) AS profit,
             COUNT(*) AS invoices
      FROM sales
      WHERE status='completed' AND date(sale_date) >= date(?)
      ${warehouseId ? 'AND warehouse_id = ?' : ''}
      GROUP BY day ORDER BY day
    `).all(...(warehouseId ? [daysAgo(29), warehouseId] : [daysAgo(29)]));

    const topProducts = db.prepare(`
      SELECT l.sku, l.description, ROUND(SUM(l.quantity),2) AS units,
             ROUND(SUM(l.line_total),2) AS revenue
      FROM sale_lines l JOIN sales s ON s.id = l.sale_id AND s.status='completed'
      WHERE date(s.sale_date) >= date(?)
      GROUP BY l.variant_id ORDER BY revenue DESC LIMIT 8
    `).all(daysAgo(29));

    const lowStock = repositories.inventory.lowStock(warehouseId, 10);

    const recentSales = db.prepare(`
      SELECT s.id, s.invoice_no, s.sale_date, s.total_amount, s.payment_method, s.status,
             COALESCE(c.name, 'Walk-in') AS customer_name, u.full_name AS cashier_name
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN users u ON u.id = s.created_by
      ORDER BY s.id DESC LIMIT 8
    `).all();

    const pendingPurchases = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS value
      FROM purchase_orders WHERE status IN ('ordered','partially_received')
    `).get();

    const receivables = db.prepare(`
      SELECT COALESCE(SUM(total_amount - paid_amount),0) AS value, COUNT(*) AS n
      FROM sales WHERE status='completed' AND total_amount - paid_amount > 0.01
    `).get();

    const counts = {
      products: db.prepare('SELECT COUNT(*) AS n FROM products WHERE is_active = 1').get().n,
      variants: db.prepare('SELECT COUNT(*) AS n FROM product_variants WHERE is_active = 1').get().n,
      customers: db.prepare('SELECT COUNT(*) AS n FROM customers WHERE is_active = 1').get().n,
      suppliers: db.prepare('SELECT COUNT(*) AS n FROM suppliers WHERE is_active = 1').get().n,
      activePromotions: db.prepare(`
        SELECT COUNT(*) AS n FROM promotions
        WHERE is_active = 1 AND (ends_at IS NULL OR date(ends_at) >= date('now'))
      `).get().n,
    };

    return {
      kpis: {
        todayRevenue: round2(todayTotals.revenue),
        todayInvoices: todayTotals.invoice_count,
        todayProfit: round2(todayTotals.profit),
        weekRevenue: round2(week.revenue),
        monthRevenue: round2(monthTotals.revenue),
        monthProfit: round2(monthTotals.profit),
        averageBasket: round2(monthTotals.average_basket),
        stockValue: round2(stock.v),
        stockUnits: round2(stock.q),
        lowStockCount: repositories.inventory.lowStock(warehouseId, 1000).length,
        openPurchaseOrders: pendingPurchases.n,
        openPurchaseValue: round2(pendingPurchases.value),
        receivables: round2(receivables.value),
        receivableInvoices: receivables.n,
      },
      counts,
      trend,
      topProducts,
      lowStock,
      recentSales,
    };
  }

  /** Alert feed — the things a manager should act on today. */
  alerts({ warehouseId = null } = {}) {
    const db = getDb();
    const alerts = [];

    const low = repositories.inventory.lowStock(warehouseId, 1000);
    if (low.length) {
      alerts.push({
        type: 'low_stock',
        severity: low.some((r) => r.quantity <= 0) ? 'high' : 'medium',
        count: low.length,
        titleEn: `${low.length} item(s) at or below reorder level`,
        titleAr: `${low.length} صنف عند حد إعادة الطلب أو أقل`,
        route: '#/inventory?low=1',
      });
    }

    const overdue = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(total_amount - paid_amount),0) AS value
      FROM sales
      WHERE status='completed' AND total_amount - paid_amount > 0.01
        AND julianday('now') - julianday(sale_date) > 30
    `).get();
    if (overdue.n) {
      alerts.push({
        type: 'overdue_receivables',
        severity: 'high',
        count: overdue.n,
        titleEn: `${overdue.n} invoice(s) unpaid for over 30 days`,
        titleAr: `${overdue.n} فاتورة غير مدفوعة لأكثر من 30 يومًا`,
        route: '#/reports/receivables',
      });
    }

    const expiring = db.prepare(`
      SELECT COUNT(*) AS n FROM promotions
      WHERE is_active = 1 AND ends_at IS NOT NULL
        AND date(ends_at) BETWEEN date('now') AND date('now', '+7 days')
    `).get();
    if (expiring.n) {
      alerts.push({
        type: 'promotions_expiring',
        severity: 'low',
        count: expiring.n,
        titleEn: `${expiring.n} promotion(s) expire within 7 days`,
        titleAr: `${expiring.n} عرض ينتهي خلال 7 أيام`,
        route: '#/promotions',
      });
    }

    const staleDrafts = db.prepare(`
      SELECT COUNT(*) AS n FROM purchase_orders
      WHERE status='ordered' AND expected_date IS NOT NULL AND date(expected_date) < date('now')
    `).get();
    if (staleDrafts.n) {
      alerts.push({
        type: 'late_deliveries',
        severity: 'medium',
        count: staleDrafts.n,
        titleEn: `${staleDrafts.n} purchase order(s) past their expected date`,
        titleAr: `${staleDrafts.n} أمر شراء تجاوز موعد التسليم`,
        route: '#/purchases',
      });
    }

    return alerts;
  }
}

export const dashboardService = new DashboardService();
export default dashboardService;

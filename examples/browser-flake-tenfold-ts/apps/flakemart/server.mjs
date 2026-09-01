import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

/**
 * Flakemart — the deliberately flaky demo storefront (brief §7).
 *
 * Plain Node, zero dependencies, zero build step, in-memory/cookie-only
 * state. The ONLY intentional bug is in the /cart coupon flow: the "Apply"
 * button's click handler is attached client-side after a random delay
 * (~20% chance of the full 4000ms), so a fast automated click can land
 * before the handler exists — a real, common hydration race, not a fake
 * coin-flip. Every other page is boringly reliable on purpose, so Tenfold's
 * flake histogram points at exactly one step, exactly like the pitch.
 *
 * Pass ?flake=0 on the /cart URL to disable the delay entirely (handler
 * attaches immediately) — this is what proves a STABLE verdict is also
 * possible, per the brief's Definition of Done.
 *
 * Pass ?layout=v2 (sticky via cookie, like ?flake) for the Workflow Memory
 * demo hook (§11.4): it renames the "Add ... to Cart" buttons and the
 * "Checkout" link — the two click-intent elements the canonical demo plan
 * actually resolves through Workflow Memory — while leaving the coupon
 * input, the injected flakiness, and everything else untouched. Run the
 * demo plan once against the default layout, then again with ?layout=v2:
 * the report should show the untouched coupon-input step reused from
 * memory and the two renamed elements re-learned, live proof of "reuse
 * what still works, verify, adapt when the page updates." (The brief's own
 * §11.4 phrasing describes renaming the coupon button specifically and
 * moving the cart link; this implementation's "apply the coupon" click is
 * a heuristic in executeRun.ts rather than a resolver-tracked target — see
 * the README's Workflow Memory section — so v2 instead renames the two
 * elements that ARE resolved through memory, to make the demo actually
 * show what it claims to.)
 */

const PORT = Number(process.env.PORT ?? 3100);

const PRODUCTS = [
  { slug: "blue-hoodie", name: "Blue Hoodie", price: 42 },
  { slug: "red-beanie", name: "Red Beanie", price: 15 },
  { slug: "green-scarf", name: "Green Scarf", price: 22 },
];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const cookies = parseCookies(req.headers.cookie);

    // ?flake=0 (or =1) is sticky for the rest of the visit, on ANY page —
    // not just /cart — so "Try your own URL"-style navigation through real
    // links (Add to Cart, nav bar) doesn't accidentally drop the toggle.
    const flakeQueryParam = url.searchParams.get("flake");
    if (flakeQueryParam !== null) {
      setCookie(res, "flake", flakeQueryParam);
    }
    const flakeSetting = flakeQueryParam ?? cookies.flake ?? "1";

    const layoutQueryParam = url.searchParams.get("layout");
    if (layoutQueryParam !== null) {
      setCookie(res, "layout", layoutQueryParam);
    }
    const layout = (layoutQueryParam ?? cookies.layout ?? "v1") === "v2" ? "v2" : "v1";

    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "flakemart", time: new Date().toISOString() });
    }

    if (url.pathname === "/") {
      return sendHtml(res, 200, renderHome(layout));
    }

    if (url.pathname === "/cart") {
      let cart = parseCart(cookies.cart);
      const add = url.searchParams.get("add");
      if (add && PRODUCTS.some((p) => p.slug === add)) {
        cart = [...cart, add];
        setCookie(res, "cart", JSON.stringify(cart));
      }
      return sendHtml(res, 200, renderCart(cart, cookies.discount === "10", flakeSetting, layout));
    }

    if (url.pathname === "/checkout") {
      const cart = parseCart(cookies.cart);
      const discountPct = cookies.discount === "10" ? 10 : 0;
      const subtotal = cartSubtotal(cart);
      const total = +(subtotal * (1 - discountPct / 100)).toFixed(2);
      const orderId = randomUUID().slice(0, 8).toUpperCase();
      setCookie(
        res,
        "lastOrder",
        JSON.stringify({ orderId, items: cart, subtotal, discountPct, total }),
      );
      res.writeHead(302, { Location: `/order/${orderId}` });
      return res.end();
    }

    if (url.pathname.startsWith("/order/")) {
      const orderId = url.pathname.split("/")[2] ?? "";
      const lastOrder = cookies.lastOrder ? safeJson(cookies.lastOrder) : null;
      return sendHtml(res, 200, renderOrder(orderId, lastOrder));
    }

    sendHtml(res, 404, layout("Not found", "<h1>404</h1><p>Page not found.</p>"));
  } catch (err) {
    console.error(err);
    sendHtml(res, 500, layout("Error", `<h1>Something went wrong</h1><pre>${escapeHtml(String(err))}</pre>`));
  }
});

server.listen(PORT, () => {
  console.log(`Flakemart listening on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function nav(active) {
  const items = [
    ["/", "Home"],
    ["/cart", "Cart"],
    ["/checkout", "Checkout"],
  ];
  return `<nav class="nav">${items
    .map(
      ([href, label]) =>
        `<a href="${href}" class="${active === href ? "active" : ""}">${label}</a>`,
    )
    .join("")}</nav>`;
}

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · Flakemart</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; color: #1a1a1a; background: #fafafa; }
  .nav { display: flex; gap: 16px; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1px solid #ddd; }
  .nav a { text-decoration: none; color: #555; font-weight: 600; }
  .nav a.active { color: #111; border-bottom: 2px solid #111; }
  .product { border: 1px solid #ddd; border-radius: 8px; padding: 16px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; background: #fff; }
  .btn { display: inline-block; background: #111; color: #fff; padding: 8px 14px; border-radius: 6px; text-decoration: none; border: none; font-size: 14px; cursor: pointer; }
  .cart-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
  input[type="text"] { padding: 8px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
  #totals { margin-top: 16px; font-size: 16px; line-height: 1.6; }
  .order-box { border: 2px solid #111; border-radius: 8px; padding: 24px; text-align: center; background: #fff; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderHome(pageLayout) {
  const addLabel = (name) => (pageLayout === "v2" ? `Add to Bag: ${escapeHtml(name)}` : `Add ${escapeHtml(name)} to Cart`);
  const products = PRODUCTS.map(
    (p) => `
    <div class="product">
      <div><strong>${escapeHtml(p.name)}</strong><br/>$${p.price.toFixed(2)}</div>
      <a class="btn" href="/cart?add=${p.slug}" data-testid="add-${p.slug}">${addLabel(p.name)}</a>
    </div>`,
  ).join("");
  return layout("Home", `${nav("/")}<h1>Flakemart</h1><p>Everyday essentials. Deliberately flaky checkout — see README.</p>${products}`);
}

function renderCart(cart, discountApplied, flakeSetting, pageLayout) {
  const items = cart.length
    ? cart
        .map((slug) => PRODUCTS.find((p) => p.slug === slug))
        .filter(Boolean)
        .map((p) => `<div class="cart-item"><span>${escapeHtml(p.name)}</span><span>$${p.price.toFixed(2)}</span></div>`)
        .join("")
    : "<p>Your cart is empty. <a href=\"/\">Go shopping</a>.</p>";

  const subtotal = cartSubtotal(cart);
  const flakeOff = flakeSetting === "0";

  return layout(
    "Cart",
    `${nav("/cart")}<h1>Your Cart</h1>${items}
    <div id="coupon-section" style="margin-top:16px">
      <input id="coupon-input" type="text" placeholder="Coupon code" data-testid="coupon-input" />
      <button id="apply-btn" class="btn" data-testid="apply-coupon">Apply</button>
    </div>
    <div id="totals">Subtotal: $${subtotal.toFixed(2)}</div>
    <p style="margin-top:24px"><a class="btn" href="/checkout" data-testid="go-checkout">${pageLayout === "v2" ? "Confirm Order" : "Place Order"}</a></p>
    <script>
      (function () {
        var flakeOff = ${flakeOff ? "true" : "false"};
        // ~20% chance of the worst case (4000ms, always loses the race against
        // an automated click); otherwise a near-instant attach that a script
        // reliably beats, matching real users on a warm cache.
        var delay = flakeOff ? 0 : (Math.random() < 0.2 ? 4000 : Math.floor(Math.random() * 40));
        var subtotal = ${subtotal};
        setTimeout(function () {
          var btn = document.getElementById('apply-btn');
          if (!btn) return;
          btn.addEventListener('click', function () {
            var code = document.getElementById('coupon-input').value.trim().toUpperCase();
            var totals = document.getElementById('totals');
            if (code === 'SAVE10') {
              var discounted = (subtotal * 0.9).toFixed(2);
              totals.innerHTML = 'Subtotal: $' + subtotal.toFixed(2) +
                '<br/>10% discount applied (SAVE10)<br/>Total: $' + discounted;
              document.cookie = 'discount=10; path=/';
            } else {
              totals.insertAdjacentHTML('beforeend', '<br/>Invalid coupon code');
            }
          });
        }, delay);
      })();
    </script>`,
  );
}

function renderOrder(orderId, lastOrder) {
  const body = lastOrder
    ? `<div class="order-box">
        <h1>Order #${escapeHtml(orderId)} confirmed</h1>
        <p>Thank you for your order!</p>
        <p>Subtotal: $${lastOrder.subtotal.toFixed(2)}${
        lastOrder.discountPct ? `<br/>${lastOrder.discountPct}% discount applied` : ""
      }<br/><strong>Total: $${lastOrder.total.toFixed(2)}</strong></p>
      </div>`
    : `<div class="order-box"><h1>Order #${escapeHtml(orderId)} confirmed</h1><p>Thank you for your order!</p></div>`;
  return layout("Order confirmed", `${nav("/checkout")}${body}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cartSubtotal(cart) {
  return cart.reduce((sum, slug) => {
    const p = PRODUCTS.find((p) => p.slug === slug);
    return sum + (p ? p.price : 0);
  }, 0);
}

function parseCart(raw) {
  if (!raw) return [];
  const arr = safeJson(raw);
  return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
}

function safeJson(raw) {
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = v;
  }
  return out;
}

function setCookie(res, name, value) {
  const existing = res.getHeader("Set-Cookie");
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=3600`;
  const list = existing ? (Array.isArray(existing) ? existing : [String(existing)]) : [];
  list.push(cookie);
  res.setHeader("Set-Cookie", list);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

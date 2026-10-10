# Endpoints (APIs and URLs)

```yaml
source:
  type: json                                  # or csv
  url: https://api.example.com/products
  headers: { Authorization: "${PRODUCTS_API_TOKEN}" }   # value in .env
  rows: data.items                            # where the list is, if wrapped
key: { field: sku }
fields:
  map: { "price.amount": "Price" }            # nested values as dotted names
```

- **Each preview and sync fetches the URL once with GET.** Nothing is sent to the endpoint, and nothing is stored.
- **The response** can be JSON or CSV:
  - JSON can be a plain list, or a list under `rows`, `records`, `data` or `items`.
  - Anything deeper needs `rows`.
- **Nested values** become dotted names (`address.city`), and lists stay lists.
- **Secrets:** put tokens in `.env` and refer to them as `${NAME}`. The wizard does this for you, and tokens inside a URL are moved to `.env` automatically.

## Find the shape first

```bash
framer-cms-sync inspect https://api.example.com/products --header "Authorization: Bearer …"
```

If the records aren't at the top level, it lists where lists were found, e.g. `result.products (24 items)`. Inspect again with `--rows result.products` to see the fields and a suggested `source:` line.

## Data sent in, instead of fetched

If n8n, a script or an agent **sends** the rows, nothing needs fetching. POST them to `/syncs/<sync>/apply` (see `framer-cms-sync-http`). Sent data counts as partial (add and update) unless the request says `complete=true` or `replace=true`.

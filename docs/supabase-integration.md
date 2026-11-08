# Supabase integration verification

Connected existing project: `cvernmhpnsgdtegvblyc`, organization `cphrmqydhzcsrrakppei`. No new project or paid branch was created.

## Scope

Only `public.fxc_journals`, `public.fxc_trades`, `public.fxc_load_journal()`, and `public.fxc_save_journal(bigint,jsonb)` were added. Their migration files use the exact versions returned by the remote migration history. Existing application tables, functions, Auth providers, email templates, and redirect settings were preserved.

## Verified on the database

- Both FXC tables have RLS enabled, with separate select/insert/update/delete ownership policies (eight policies total).
- Authenticated accounts can read and save their own journal. Another account cannot read, insert, modify, delete, or take ownership of those records.
- Both functions use SECURITY INVOKER and an empty search_path. Anonymous execution is revoked.
- Cloud save and load round-trip exact integer cents. Invalid dates roll back without changing the journal or revision.
- A stale revision is rejected. Deleting a trade and changing preferences are part of the same transaction.
- Direct anonymous HTTP requests to both FXC tables and the read RPC return HTTP 401 with PostgreSQL code 42501.
- Database integration assertions ran inside a rolled-back transaction. No test accounts or trades remain.
- Security and performance advisors reported no findings for the new FXC objects. Existing project findings remain outside this change.

## Existing shared-project findings

The pre-existing policies named `stats dashboard read access` on `public.users` and `public.usdt_orders` allow anonymous/authenticated SELECT with a true predicate. These policies were not changed because they belong to the existing application. Their intended dashboard use and exposed columns should be reviewed before sharing this project's API more broadly. These findings do not grant access to FXC records.

Existing advisors also flag mutable search_path on six older functions and public execution of the existing SECURITY DEFINER function `public.handle_new_user_notification()`. This integration does not call or change those functions.

References:

- [Supabase RLS and least-privilege access](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Mutable function search_path advisory](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable)
- [Anonymous SECURITY DEFINER execution advisory](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)

## Remaining verification limits

The project reports email authentication enabled, signups enabled, and email confirmation required. No real user signup, email delivery, or password-reset email was sent during implementation. Those flows depend on the project's existing SMTP configuration and delivery quotas. Browser checks covered the account form states and preserved local-journal behavior; authenticated authorization was verified at the database role layer. Cloud reads from another device use the Refresh action, not realtime subscriptions.

Source and database integration are prepared independently of frontend hosting. Deploy the updated main branch to make the new account UI available on the public FXC website.

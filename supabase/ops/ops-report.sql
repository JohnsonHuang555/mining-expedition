-- =============================================================================
-- 營運報告（唯讀）：排程結果、積壓、市場、限流、action_log 大小
-- 用法：psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 -f supabase/ops/ops-report.sql
-- =============================================================================

begin read only;

\echo '--- cron jobs'
select jobid, jobname, schedule, active from cron.job order by jobname;

\echo '--- cron runs in the last 24 hours (by job and status)'
select j.jobname, d.status, count(*) as runs,
       round(avg(extract(epoch from (d.end_time - d.start_time)))::numeric, 2) as avg_seconds,
       round(max(extract(epoch from (d.end_time - d.start_time)))::numeric, 2) as max_seconds,
       max(d.start_time) as last_start
from cron.job_run_details d join cron.job j on j.jobid = d.jobid
where d.start_time > now() - interval '24 hours'
group by j.jobname, d.status order by j.jobname, d.status;

\echo '--- last failures (7 days)'
select j.jobname, d.start_time, d.status, left(d.return_message, 200) as message
from cron.job_run_details d join cron.job j on j.jobid = d.jobid
where d.status <> 'succeeded' and d.start_time > now() - interval '7 days'
order by d.start_time desc limit 20;

\echo '--- action_log backlog (should stay near 0)'
select private.action_log_backlog() as backlog;

\echo '--- action_log size'
select count(*) as rows, count(*) filter (where response is null) as compacted,
       pg_size_pretty(pg_total_relation_size('public.action_log')) as total_size
from public.action_log;

\echo '--- market: today and the last 7 days (12 artifacts per day expected)'
select price_date, count(*) as artifacts from public.market_prices
where price_date >= private.market_date(now()) - 7 group by price_date order by price_date desc;

\echo '--- rate limit counters (rows = distinct user × bucket)'
select bucket, count(*) as users from private.rate_limits group by bucket order by bucket;

\echo '--- connections by state'
select state, count(*) from pg_stat_activity where datname = current_database() group by state order by 2 desc;

rollback;

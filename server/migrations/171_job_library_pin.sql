-- A job that runs a saved query is pinned to the version its owner saw when saving the job.
-- Without the pin, whoever edits the saved query later (its owner, or anyone for 'shared' queries)
-- would choose the SQL that runs with the job owner's access.
alter table sched_jobs add column library_version int;

-- Existing jobs keep running what they ran before: pin them to the saved query's current version.
update sched_jobs j set library_version = l.version
  from library_queries l
 where j.library_id = l.id and j.library_version is null;

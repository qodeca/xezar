## 🚀 CI/CD & Infrastructure

- 🚀 **The nightly mutation run finishes again.** Since mid-September two to four of its nine jobs
  hit the five-hour limit every night, so no night produced a score: the work had grown to about
  35 runner-hours and the jobs were balanced on month-old estimates. Jobs are now planned on
  measured minutes per file, as many as needed to keep each well under the limit (18 today), and
  each job records its own timings so the plan can be refreshed from any night, even one cut short.
  The Qwen Code adapter's source check no longer trips over the mutation tool's own code, which had
  stopped one job before it started. Scope and the 80 % floor are unchanged. (#443)
- 🚀 **The read-only command lock is mutation-tested every night.** The lock and Qwen Code's tool
  policy now run beside the nightly gate with their own 71 % floor, in the same verdict and the same
  tracking issue.

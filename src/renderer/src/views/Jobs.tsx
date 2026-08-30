import { useEffect, useState, useRef } from 'react'
import type { Job, StreamEvent, Artifact } from '../types'
import { STAGE_LIST, STATUS_LABEL } from '../types'
import JobDetail from './JobDetail'

interface Props {
  jobs: Job[]
  selectedJobId: string | null
  onSelect: (id: string | null) => void
  onChanged: () => void
}

export default function Jobs({ jobs, selectedJobId, onSelect, onChanged }: Props) {
  const selected = jobs.find((j) => j.id === selectedJobId) ?? null

  return (
    <div className="jobs-layout">
      <div className="job-list">
        <div className="job-list-header">
          <h2>Jobs</h2>
          <span className="muted">{jobs.length} total</span>
        </div>
        {jobs.length === 0 && (
          <div className="empty">
            No jobs yet. Go to <b>Channels</b> to ingest a YouTube channel and queue videos.
          </div>
        )}
        {jobs.map((job) => (
          <button
            key={job.id}
            className={`job-item ${job.id === selectedJobId ? 'selected' : ''}`}
            onClick={() => onSelect(job.id)}
          >
            <div className="job-item-top">
              <span className={`status-dot status-${job.status}`} />
              <span className="job-title">{job.title || job.id}</span>
            </div>
            <div className="job-item-bottom">
              <span className={`chip status-chip-${job.status}`}>{STATUS_LABEL[job.status] ?? job.status}</span>
              {job.language !== 'en' && <span className="chip">{job.language}</span>}
              {job.stage && <span className="muted small">{job.stage}</span>}
            </div>
          </button>
        ))}
      </div>
      {selected ? (
        <JobDetail key={selected.id} job={selected} onChanged={onChanged} />
      ) : (
        <div className="job-detail empty">Select a job to inspect it.</div>
      )}
    </div>
  )
}

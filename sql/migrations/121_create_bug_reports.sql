-- Create bug_reports table to store in-app bug submissions
CREATE TABLE IF NOT EXISTS bug_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_code TEXT UNIQUE NOT NULL,
    reported_by UUID REFERENCES users(id) ON DELETE SET NULL,
    channel TEXT NOT NULL DEFAULT 'web',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    repro_steps TEXT,
    category TEXT NOT NULL DEFAULT 'other',
    impact TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_context JSONB NOT NULL DEFAULT '{}'::jsonb,
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
    attachment_bundle_id UUID,
    acknowledged_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT bug_reports_channel_check CHECK (channel IN ('web', 'ios', 'android', 'desktop', 'api')),
    CONSTRAINT bug_reports_category_check CHECK (category IN ('ui', 'performance', 'sync', 'data', 'other')),
    CONSTRAINT bug_reports_impact_check CHECK (impact IN ('blocker', 'high', 'medium', 'low')),
    CONSTRAINT bug_reports_status_check CHECK (status IN ('open', 'triaged', 'in_progress', 'resolved', 'wont_fix', 'duplicate'))
);

CREATE TRIGGER update_bug_reports_updated_at
BEFORE UPDATE ON bug_reports
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Track internal notes / status history while keeping main table lean
CREATE TABLE IF NOT EXISTS bug_report_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bug_report_id UUID NOT NULL REFERENCES bug_reports(id) ON DELETE CASCADE,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for admin dashboards and filtering
CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports (status);
CREATE INDEX IF NOT EXISTS idx_bug_reports_category_impact ON bug_reports (category, impact);
CREATE INDEX IF NOT EXISTS idx_bug_reports_reported_by_created_at ON bug_reports (reported_by, created_at DESC);

COMMENT ON TABLE bug_reports IS 'Primary store for in-app bug reports submitted by beta users.';
COMMENT ON COLUMN bug_reports.reference_code IS 'Short, human-friendly identifier shown to reporters.';
COMMENT ON COLUMN bug_reports.metadata IS 'JSON payload containing environment details (app version, device info, feature flags).';
COMMENT ON COLUMN bug_reports.source_context IS 'Optional JSON payload describing where the bug occurred (route, entity IDs, experiments).';

COMMENT ON TABLE bug_report_notes IS 'Internal notes and triage updates associated with a bug report.';

-- Add a dedicated support-staff role (scoped to the Support Chat section).
-- Placed after 'dispute_agent' to mirror the staff-role grouping.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'support_agent' BEFORE 'admin';

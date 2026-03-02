/**
 * JXA accessor registry — per-entity maps from var name to JXA expression generator.
 *
 * Extracted from variables.ts to keep architecture-neutral metadata separate
 * from JXA-specific codegen. Only jxaCompiler.ts (backend) needs this.
 */

import type { EntityType } from '../variables.js';

export type JxaAccessor = (itemVar: string) => string;
export type JxaAccessorRegistry = Record<string, JxaAccessor>;

export const taskJxaAccessors: JxaAccessorRegistry = {
  id:                   v => `${v}.id.primaryKey`,
  name:                 v => `(${v}.name || "")`,
  flagged:              v => `${v}.flagged`,
  dueDate:              v => `${v}.dueDate`,
  deferDate:            v => `${v}.deferDate`,
  plannedDate:          v => `${v}.plannedDate`,
  effectiveDueDate:     v => `${v}.effectiveDueDate`,
  effectiveDeferDate:   v => `${v}.effectiveDeferDate`,
  effectivePlannedDate: v => `${v}.effectivePlannedDate`,
  completionDate:       v => `${v}.completionDate`,
  modificationDate:     v => `${v}.modified`,
  creationDate:         v => `${v}.added`,
  estimatedMinutes:     v => `${v}.estimatedMinutes`,
  blocked:              v => `${v}.blocked`,
  effectivelyCompleted: v => `${v}.effectivelyCompleted`,
  effectivelyDropped:   v => `${v}.effectivelyDropped`,
  completed:            v => `(${v}.taskStatus === Task.Status.Completed)`,
  dropped:              v => `(${v}.taskStatus === Task.Status.Dropped)`,
  projectName:          v => `(${v}.containingProject ? ${v}.containingProject.name || "" : "")`,
  projectId:            v => `(${v}.containingProject ? ${v}.containingProject.id.primaryKey : null)`,
  inInbox:              v => `${v}.inInbox`,
  sequential:           v => `${v}.sequential`,
  childCount:           v => `(${v}.children ? ${v}.children.length : 0)`,
  parentId:             v => `(${v}.parent ? ${v}.parent.id.primaryKey : null)`,
  tags:                 v => `${v}.tags.map(function(t){return t.name.toLowerCase();})`,
  status:               v => `taskStatusMap[${v}.taskStatus]`,
  hasChildren:          v => `(${v}.children ? ${v}.children.length > 0 : false)`,
  note:                 v => `(${v}.note || "")`,
  now:                  _  => '_now',
};

export const projectJxaAccessors: JxaAccessorRegistry = {
  id:                 v => `${v}.id.primaryKey`,
  name:               v => `(${v}.name || "")`,
  status:             v => `projectStatusMap[${v}.status]`,
  flagged:            v => `${v}.flagged`,
  completed:          v => `(${v}.status === Project.Status.Done)`,
  dueDate:            v => `${v}.dueDate`,
  deferDate:          v => `${v}.deferDate`,
  effectiveDueDate:   v => `${v}.effectiveDueDate`,
  effectiveDeferDate: v => `${v}.effectiveDeferDate`,
  completionDate:     v => `${v}.completionDate`,
  modificationDate:   v => `${v}.task.modified`,
  creationDate:       v => `${v}.task.added`,
  estimatedMinutes:   v => `${v}.estimatedMinutes`,
  sequential:         v => `${v}.sequential`,
  taskCount:          v => `(${v}.tasks ? ${v}.tasks.length : 0)`,
  activeTaskCount:    v => `(${v}.tasks ? ${v}.tasks.filter(t => t.taskStatus !== Task.Status.Completed && t.taskStatus !== Task.Status.Dropped).length : 0)`,
  folderId:           v => `(${v}.parentFolder ? ${v}.parentFolder.id.primaryKey : null)`,
  folderName:         v => `(${v}.parentFolder ? ${v}.parentFolder.name : null)`,
  note:               v => `(${v}.note || "")`,
  now:                _  => '_now',
};

export const folderJxaAccessors: JxaAccessorRegistry = {
  id:             v => `${v}.id.primaryKey`,
  name:           v => `(${v}.name || "")`,
  hidden:         v => `${v}.hidden`,
  parentFolderId: v => `(${v}.parent ? ${v}.parent.id.primaryKey : null)`,
  projectCount:   v => `(${v}.projects ? ${v}.projects.length : 0)`,
  status:         v => `folderStatusMap[${v}.status]`,
  now:            _  => '_now',
};

export const tagJxaAccessors: JxaAccessorRegistry = {
  id:                 v => `${v}.id.primaryKey`,
  name:               v => `(${v}.name || "")`,
  allowsNextAction:   v => `${v}.allowsNextAction`,
  hidden:             v => `${v}.hidden`,
  effectivelyHidden:  v => `${v}.effectivelyHidden`,
  availableTaskCount: v => `(${v}.availableTasks ? ${v}.availableTasks.length : 0)`,
  remainingTaskCount: v => `(${v}.remainingTasks ? ${v}.remainingTasks.length : 0)`,
  parentId:           v => `(${v}.parent ? ${v}.parent.id.primaryKey : null)`,
  parentName:         v => `(${v}.parent ? ${v}.parent.name : null)`,
  note:               v => `(${v}.note || "")`,
  now:                _  => '_now',
};

export const perspectiveJxaAccessors: JxaAccessorRegistry = {
  id:   v => `${v}.id.primaryKey`,
  name: v => `(${v}.name || "")`,
};

export function getJxaAccessorRegistry(entity: EntityType): JxaAccessorRegistry {
  switch (entity) {
    case 'tasks':        return taskJxaAccessors;
    case 'projects':     return projectJxaAccessors;
    case 'folders':      return folderJxaAccessors;
    case 'tags':         return tagJxaAccessors;
    case 'perspectives': return perspectiveJxaAccessors;
  }
}

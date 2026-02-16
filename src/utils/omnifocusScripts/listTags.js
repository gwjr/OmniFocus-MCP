// OmniJS script to list all tags in OmniFocus
(() => {
  try {
    const results = [];

    // flattenedTags gives us every tag including nested ones
    const allTags = flattenedTags;

    for (let i = 0; i < allTags.length; i++) {
      const tag = allTags[i];
      const statusName =
        tag.status === Tag.Status.Active ? "Active" :
        tag.status === Tag.Status.Dropped ? "Dropped" :
        tag.status === Tag.Status.OnHold ? "OnHold" :
        "Unknown";

      // Count available (non-completed, non-dropped) tasks
      const availableTasks = tag.tasks.filter(t =>
        t.taskStatus !== Task.Status.Completed &&
        t.taskStatus !== Task.Status.Dropped
      );

      results.push({
        id: tag.id.primaryKey,
        name: tag.name,
        status: statusName,
        parent: tag.parent ? tag.parent.name : null,
        taskCount: availableTasks.length,
        active: tag.active
      });
    }

    return JSON.stringify({
      success: true,
      tags: results,
      count: results.length
    });

  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error.toString()
    });
  }
})()

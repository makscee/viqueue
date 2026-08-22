# Viqueue

Viqueue is one private operating system for the coordinator’s own tasks and work delegated to paired workers.

## Language

**Activity feed**:
A chronological view of factual events that recently happened in Viqueue. Only unresolved questions receive emphasis—stronger when blocking—while all other events use ordinary feed styling; the feed makes no inferred judgments about progress, urgency, or failure.
_Avoid_: Activity dashboard, attention detector, importance score

**Ticket event**:
An append-only factual history entry attached to a ticket, created automatically by lifecycle actions or added manually when useful. Events cannot be edited or deleted; a later event records any correction. Optional context is an event rather than a prerequisite for changing board state.
_Avoid_: Mutable event, mandatory transition note, inferred event

**Question**:
An explicit, one-shot request from a worker for coordinator input. Questions are the primary interface between workers and the coordinator; they may be blocking or non-blocking, and a response answers the question rather than opening a chat thread.
_Avoid_: Alert, inferred attention item, conversation thread

**Blocking question**:
A question whose answer is required before Agent execution can continue. Asking one moves the ticket to Waiting and releases the claim immediately so that machine may take other work; answering the last moves the ticket to Open, where any Agent machine may claim it. If a non-blocking question later becomes essential, the Agent asks a new blocking question.
_Avoid_: Separate blocker, inferred stall, promoted question, claim grace period

**Approval question**:
A blocking question created when a worker submits completed work. Its answer is either acceptance or a request for changes, so review uses the same interface as every other coordinator decision.
_Avoid_: Separate review queue, review inbox

**Open questions**:
The persistent collection of unanswered questions, shown first in the Activity column and repeated inside their ticket popup. Both locations expose the same inline answer controls and update the same question; answered questions remain in ticket history rather than a separate archive. Blocking questions are explicit, and newer activity cannot bury an open question.
_Avoid_: Alerts, inferred attention queue, answer modal, separate question archive

**Ticket**:
A captured idea or work request belonging to exactly one project. An unassigned Open ticket sits in the backlog; assignment makes responsibility explicit.
_Avoid_: Draft ticket, ready state, multiple project membership

**Completion**:
Done is the permanent visible history of completed work, progressively loaded within the global board. There is no Archive state, Archive view, or Restore flow.
_Avoid_: Archive, automatic retention rule

**Deletion**:
A confirmed destructive action that permanently removes a ticket from the board and search while retaining a hidden tombstone and history so its ID is never reused and old references remain truthful. There is no Trash or Restore interface.
_Avoid_: Recycle bin, restorable deletion, ID reuse

**Project**:
The single immutable project to which a ticket belongs and the filtering dimension on the global board. A project has a stable key and its own ticket counter; it is not a separate page or workspace.
_Avoid_: Multiple project membership, project page, mutable ticket project

**Global board**:
The single five-column operating surface: Open, Working, Waiting, Done, and Activity. One project selection scopes all five columns with OR semantics: tickets, open questions, and events remain visible when they belong to any selected project. Navigation never splits work into separate project pages.
_Avoid_: Project board, project page, separate activity view, globally unfiltered Activity column, AND project filter

**Activity column**:
The fifth column of the global board. Open questions appear first, followed by the complete reverse-chronological activity feed; the column scrolls independently from the four ticket columns.
_Avoid_: Activity page, questions modal, dashboard widget

**Mobile board**:
The global board becomes five single-column tabs at narrow widths, with Activity selected by default. Project filtering and quick capture remain available above the tabs.
_Avoid_: Separate mobile information architecture, horizontally compressed five-column board

**Ticket ID**:
The immutable identifier formed from the ticket’s project key and that project’s counter, such as `VIQ-12`. IDs never change or return to the counter.
_Avoid_: Global sequence, mutable ticket ID

**Board state**:
A ticket’s explicit position in Open, Working, Waiting, or Done. Backlog is Unassigned + Open; review is Waiting with an open approval question. Humans move Human work by drag; Agent lifecycle moves Agent work: claim to Working, blocking question or submission to Waiting, and acceptance to Done. Blocking answers, release, or requested changes return Agent work to Open.
_Avoid_: To do column, Review column, state dropdown, board-owned Agent process control

**Waiting**:
An explicit board state meaning execution is paused. Entering Waiting requires no separate reason or contract; a blocking question, approval, or optional manually added event may provide context.
_Avoid_: Inferred stall, mandatory wait reason, mandatory question for every wait

**Role**:
The kind of worker responsible for work: Human or Agent. These are the only assignment roles in the initial product.
_Avoid_: Me role, Operator role, specialty role, per-machine role

**Machine**:
A named execution source associated with either Human or Agent role. Any number of machines may belong to each role; every event records its machine, and an active Working Agent card may show the machine as secondary provenance. Machine identity is never an assignment target or filter.
_Avoid_: Machine assignment, machine filter, machine-specific queue

**Claim**:
The atomic lock held by one Agent machine while it executes a ticket. A claim records execution provenance without changing the ticket’s Agent assignment.
_Avoid_: Claim as assignment, human claim

**Assignment**:
The explicit boundary between retained and owned work: Unassigned, Human, or Agent. Human records human responsibility; Agent exposes an Open ticket to polling Agent machines; Unassigned remains Open in the backlog.
_Avoid_: Named-human assignment, machine assignment, Start action, implicit free pool

**Assignment filter**:
The global board may be narrowed by Human or Agent role. Machines and Unassigned are not separate filter options.
_Avoid_: Me filter, machine filter, unassigned filter, generic filter builder

**Column order**:
The visible order of cards within each ticket column. Every column sorts by most recent update by default and supports the same manual reordering interaction; any later ticket update moves that card to the top. Only Open order has execution meaning, with workers claiming the first eligible assigned ticket. The Open order is global, and project filters reveal a subsequence rather than creating project-specific ranks.
_Avoid_: FIFO claim order, hidden worker priority, per-project order, sticky manual rank, different reorder interaction by column

**Ticket card**:
The compact board representation of a ticket: ticket ID, title, assignment or Unassigned, and an open-question indicator when applicable. Clicking opens the full ticket and dragging changes state or order; cards contain no state control, project chips, description preview, action buttons, or timestamp.
_Avoid_: Miniature ticket detail, card action toolbar

**Ticket creation**:
A compact popup opened from one `+ Ticket` button, because capture should be available without permanently occupying the board. Project and title are required; description and assignment are optional. State is absent.
_Avoid_: Persistent creation composer, primary-project field, state field

**Ticket popup**:
The single overlay opened from a ticket card, showing identity, project, description, assignment, questions, chronological ticket events, and the few ticket actions. Edit switches this popup in place for title, description, and assignment while identity, project, and state remain read-only. An always-visible event composer submits directly without first opening another form. The popup becomes full-screen on a phone and never opens a separate ticket page, drawer, or nested popup.
_Avoid_: Ticket page, side drawer, nested modal, hidden add-event form

**Decision desk**:
The coordinator’s primary view: recent factual activity with unresolved questions made prominent. It is the opening surface of a broader operating system that also exposes projects, active work, backlog, and quick capture without inferred attention state.
_Avoid_: Generic dashboard, kanban board

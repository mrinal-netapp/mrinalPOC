package routes

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	failurepb "go.temporal.io/api/failure/v1"
	historypb "go.temporal.io/api/history/v1"
	taskqueuepb "go.temporal.io/api/taskqueue/v1"
)

func TestHistoryEventToLogEntry_AllEventTypes(t *testing.T) {
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		eventType enumspb.EventType
		contains  string
		build     func() *historypb.HistoryEvent
	}{
		{
			enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED,
			"completed successfully",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{EventId: 1, EventTime: &now, EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED}
			},
		},
		{
			enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT,
			"timed out",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{EventId: 2, EventTime: &now, EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TIMED_OUT}
			},
		},
		{
			enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED,
			"cancelled",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{EventId: 3, EventTime: &now, EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_CANCELED}
			},
		},
		{
			enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED,
			"terminated",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{EventId: 4, EventTime: &now, EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_TERMINATED}
			},
		},
		{
			enumspb.EVENT_TYPE_ACTIVITY_TASK_STARTED,
			"Activity started",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{EventId: 5, EventTime: &now, EventType: enumspb.EVENT_TYPE_ACTIVITY_TASK_STARTED}
			},
		},
		{
			enumspb.EVENT_TYPE_ACTIVITY_TASK_COMPLETED,
			"Activity completed",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{EventId: 6, EventTime: &now, EventType: enumspb.EVENT_TYPE_ACTIVITY_TASK_COMPLETED}
			},
		},
		{
			enumspb.EVENT_TYPE_ACTIVITY_TASK_FAILED,
			"boom",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{
					EventId: 7, EventTime: &now, EventType: enumspb.EVENT_TYPE_ACTIVITY_TASK_FAILED,
					Attributes: &historypb.HistoryEvent_ActivityTaskFailedEventAttributes{
						ActivityTaskFailedEventAttributes: &historypb.ActivityTaskFailedEventAttributes{
							Failure: &failurepb.Failure{Message: "boom"},
						},
					},
				}
			},
		},
		{
			enumspb.EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT,
			"timed out",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{EventId: 8, EventTime: &now, EventType: enumspb.EVENT_TYPE_ACTIVITY_TASK_TIMED_OUT}
			},
		},
		{
			enumspb.EVENT_TYPE_TIMER_STARTED,
			"Timer started",
			func() *historypb.HistoryEvent {
				dur := 5 * time.Second
				return &historypb.HistoryEvent{
					EventId: 9, EventTime: &now, EventType: enumspb.EVENT_TYPE_TIMER_STARTED,
					Attributes: &historypb.HistoryEvent_TimerStartedEventAttributes{
						TimerStartedEventAttributes: &historypb.TimerStartedEventAttributes{
							StartToFireTimeout: &dur,
						},
					},
				}
			},
		},
		{
			enumspb.EVENT_TYPE_TIMER_FIRED,
			"Timer fired",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{EventId: 10, EventTime: &now, EventType: enumspb.EVENT_TYPE_TIMER_FIRED}
			},
		},
		{
			enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
			"q1",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{
					EventId: 11, EventTime: &now, EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
					Attributes: &historypb.HistoryEvent_WorkflowExecutionStartedEventAttributes{
						WorkflowExecutionStartedEventAttributes: &historypb.WorkflowExecutionStartedEventAttributes{
							TaskQueue: &taskqueuepb.TaskQueue{Name: "q1"},
						},
					},
				}
			},
		},
		{
			enumspb.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED,
			"FetchCreds",
			func() *historypb.HistoryEvent {
				return &historypb.HistoryEvent{
					EventId: 12, EventTime: &now, EventType: enumspb.EVENT_TYPE_ACTIVITY_TASK_SCHEDULED,
					Attributes: &historypb.HistoryEvent_ActivityTaskScheduledEventAttributes{
						ActivityTaskScheduledEventAttributes: &historypb.ActivityTaskScheduledEventAttributes{
							ActivityType: &commonpb.ActivityType{Name: "FetchCreds"},
						},
					},
				}
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.eventType.String(), func(t *testing.T) {
			entry := historyEventToLogEntry(tc.build())
			assert.Contains(t, entry.Details, tc.contains)
		})
	}
}

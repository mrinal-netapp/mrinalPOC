package routes

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/mocks"
)

func TestConnectorRoute_DeleteSchedule_ServiceError(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("GetHandle", mock.Anything, "acq-p-d").Return(schedHandle)
	schedHandle.On("Delete", mock.Anything).Return(errors.New("delete failed")).Once()

	body := bytes.NewBufferString(`{"temporalScheduleId":"acq-p-d"}`)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/datasets/d/schedule", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestConnectorRoute_GetSchedule_ServiceError(t *testing.T) {
	r, mt, _, _ := newConnectorRouter(t, false)
	schedClient := &mocks.ScheduleClient{}
	schedHandle := &mocks.ScheduleHandle{}
	mt.On("ScheduleClient").Return(schedClient)
	schedClient.On("GetHandle", mock.Anything, "acq-p-d").Return(schedHandle)
	schedHandle.On("Describe", mock.Anything).Return(nil, errors.New("describe failed")).Once()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/datasets/d/schedule?temporalScheduleId=acq-p-d", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusInternalServerError, w.Code)
}

func TestConnectorRoute_DeleteSchedule_MissingBody(t *testing.T) {
	r, _, _, _ := newConnectorRouter(t, false)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/projects/p/datasets/d/schedule", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusBadRequest, w.Code)
}

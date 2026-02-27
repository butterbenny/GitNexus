import Axios from 'axios';

export const fetchAccountNotifications = (accountId: number) => {
  return Axios.get(`/accounts/${accountId}/notifications`);
};

export const createAccountNotification = (accountId: number) => {
  return Axios.post(`/accounts/${accountId}/notifications`, {});
};

export const fetchAccountNotification = (accountId: number, notificationId: number) => {
  return Axios.get(`/accounts/${accountId}/notifications/${notificationId}`);
};

export const updateAccountNotification = (accountId: number, notificationId: number) => {
  return Axios.patch(`/accounts/${accountId}/notifications/${notificationId}`, {});
};

export const deleteAccountNotification = (accountId: number, notificationId: number) => {
  return Axios.delete(`/accounts/${accountId}/notifications/${notificationId}`);
};


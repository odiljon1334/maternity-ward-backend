import { HikvisionService } from './hikvision.service';
import * as fs from 'fs';

function setup() {
  const prisma = {
    hikTerminal: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 't', hospitalId: 'h', devIndex: 'd' }),
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 't', hospitalId: 'h', devIndex: 'd' }),
    },
    employee: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'e',
        hospitalId: 'h',
        status: 'ACTIVE',
        photoUrl: null,
        user: null,
      }),
      findMany: jest.fn().mockResolvedValue([{ id: 'e', photoUrl: null }]),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const svc: any = new HikvisionService(
    { get: (_: string, d: unknown) => d } as any,
    prisma as any,
    {} as any,
  );
  svc.getTerminalStatusSnapshot = jest.fn().mockResolvedValue({ d: 'online' });
  svc.readTerminalPerson = jest
    .fn()
    .mockResolvedValue({ employeeNo: '101', name: 'Ali', numOfFace: 1 });
  svc.digestRequest = jest.fn().mockResolvedValue({ data: { statusCode: 1 } });
  svc.deletePerson = jest.fn().mockResolvedValue({ statusCode: 1 });
  svc.addFacePicture = jest.fn().mockResolvedValue({ statusCode: 1 });
  svc.compressFace = jest.fn().mockResolvedValue(Buffer.from('jpg'));
  return { svc, prisma };
}
const task: any = {
  id: 'task',
  terminalId: 't',
  hospitalId: 'h',
  employeeNo: '101',
  fullName: 'Ali',
  action: 'UPSERT',
  photoUrl: '/uploads/new.jpg',
  deliveredPhotoUrl: '/uploads/old.jpg',
};
afterEach(() => jest.restoreAllMocks());

describe('Durable employee terminal delivery', () => {
  it('explicit person API does not claim a photo-less employee was queued', async () => {
    const { svc, prisma } = setup();
    await expect(svc.queueDevicePerson('d', '101')).resolves.toEqual({
      queued: false,
      reason: 'NO_PHOTO',
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('unchanged confirmed person/photo requires one read and no device writes or compression', async () => {
    const { svc } = setup();
    jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('photo'));
    svc.readTerminalPerson.mockResolvedValue({
      employeeNo: '101',
      name: 'Ali',
      numOfFace: 1,
      userType: 'normal',
      Valid: {
        enable: true,
        beginTime: '2020-01-01T00:00:00',
        endTime: '2037-12-31T23:59:59',
      },
    });
    await svc.deliverPerson(
      { ...task, deliveredPhotoUrl: task.photoUrl },
      jest.fn(),
    );
    expect(svc.readTerminalPerson).toHaveBeenCalledTimes(1);
    expect(svc.digestRequest).not.toHaveBeenCalled();
    expect(svc.addFacePicture).not.toHaveBeenCalled();
    expect(svc.compressFace).not.toHaveBeenCalled();
  });

  it('offline terminal cannot receive a write or confirmation', async () => {
    const { svc } = setup();
    svc.getTerminalStatusSnapshot.mockResolvedValue({ d: 'offline' });
    await expect(svc.deliverPerson(task, jest.fn())).rejects.toThrow('offline');
    expect(svc.digestRequest).not.toHaveBeenCalled();
  });
  it('new photo is upserted without deleting the existing face; person and face are read back', async () => {
    const { svc } = setup();
    jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('photo'));
    const fence = jest.fn();
    await svc.deliverPerson(task, fence);
    expect(svc.addFacePicture).toHaveBeenCalledWith(
      'd',
      '101',
      Buffer.from('jpg'),
      { compressed: true, replace: true },
    );
    expect(svc.deletePerson).not.toHaveBeenCalled();
    expect(svc.readTerminalPerson).toHaveBeenCalledTimes(2);
    expect(svc.digestRequest.mock.calls[0][2].data.UserInfo.name).toBe('Ali');
  });
  it('vendor HTTP 200 with failure status is never confirmation', async () => {
    const { svc } = setup();
    jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('photo'));
    svc.digestRequest.mockResolvedValue({ data: { statusCode: 6 } });
    await expect(svc.deliverPerson(task, jest.fn())).rejects.toThrow(
      'rad etdi',
    );
    expect(svc.addFacePicture).not.toHaveBeenCalled();
  });
  it('name readback mismatch cannot be marked delivered', async () => {
    const { svc } = setup();
    jest.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('photo'));
    svc.readTerminalPerson.mockResolvedValue({
      employeeNo: '101',
      name: 'Old name',
      numOfFace: 1,
    });
    await expect(svc.deliverPerson(task, jest.fn())).rejects.toThrow(
      'hali tasdiqlanmadi',
    );
  });
  it('photo-less employee causes zero terminal requests', async () => {
    const { svc } = setup();
    await expect(
      svc.deliverPerson({ ...task, photoUrl: null }, jest.fn()),
    ).rejects.toThrow('SKIP:NO_PHOTO');
    expect(svc.getTerminalStatusSnapshot).not.toHaveBeenCalled();
    expect(svc.digestRequest).not.toHaveBeenCalled();
  });
  it('BLOCK deletes device access and waits for absence readback', async () => {
    const { svc } = setup();
    svc.readTerminalPerson
      .mockResolvedValueOnce({ employeeNo: '101' })
      .mockResolvedValueOnce(null);
    await svc.deliverPerson({ ...task, action: 'BLOCK' }, jest.fn());
    expect(svc.deletePerson).toHaveBeenCalledWith('d', '101');
    expect(svc.addFacePicture).not.toHaveBeenCalled();
  });
  it('asynchronous delete is retried until the terminal confirms absence', async () => {
    const { svc } = setup();
    await expect(
      svc.deliverPerson({ ...task, action: 'DELETE' }, jest.fn()),
    ).rejects.toThrow('olib tashlash hali');
  });
  it('already absent DELETE is idempotent', async () => {
    const { svc } = setup();
    svc.readTerminalPerson.mockResolvedValue(null);
    await svc.deliverPerson({ ...task, action: 'DELETE' }, jest.fn());
    expect(svc.deletePerson).not.toHaveBeenCalled();
  });
  it('new revision stops writes before they reach the device', async () => {
    const { svc } = setup();
    await expect(
      svc.deliverPerson(
        task,
        jest.fn().mockRejectedValue(Error('TASK_CHANGED')),
      ),
    ).rejects.toThrow('TASK_CHANGED');
    expect(svc.digestRequest).not.toHaveBeenCalled();
  });
  it('bulk sync writes current DB desired states instead of direct stale device writes', async () => {
    const { svc, prisma } = setup();
    const job: any = { hospitalId: 'h', done: 0 };
    await svc.queueHospitalPeople(job, jest.fn());
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(svc.digestRequest).not.toHaveBeenCalled();
    expect(job.state).toBe('DONE');
    expect(job.message).toMatch(/navbatga/);
  });
});

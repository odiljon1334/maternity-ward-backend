import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import sharp from 'sharp';
import { ProfileFaceValidationService } from './profile-face-validation.service';

describe('Profile face presence validation', () => {
  let image: Buffer;
  beforeAll(async () => {
    image = await sharp({
      create: { width: 32, height: 32, channels: 3, background: 'green' },
    })
      .png()
      .toBuffer();
  });
  afterEach(() => jest.restoreAllMocks());
  it('accepts one face and caches by image content', async () => {
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { faceCount: 1 } });
    const svc = new ProfileFaceValidationService();
    await svc.assertFace(image);
    await svc.assertFace(Buffer.from(image));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatch(/\/detect$/);
  });
  it('rejects zero faces with an understandable message; caches the rejection', async () => {
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { faceCount: 0 } });
    const svc = new ProfileFaceValidationService();
    await expect(svc.assertFace(image)).rejects.toThrow(
      'Rasmda yuz aniqlanmadi',
    );
    await expect(svc.assertFace(image)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('rejects a group photo', async () => {
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { faceCount: 2 } });
    await expect(
      new ProfileFaceValidationService().assertFace(image),
    ).rejects.toThrow('bir nechta yuz');
  });
  it('fails closed on unavailable or malformed detection, does not cache failures', async () => {
    const post = jest
      .spyOn(axios, 'post')
      .mockRejectedValueOnce(Error('PRIVATE_IMAGE_CONFIG'))
      .mockResolvedValueOnce({ data: { faceCount: true } })
      .mockResolvedValue({ data: { faceCount: 1 } });
    const svc = new ProfileFaceValidationService();
    await expect(svc.assertFace(image)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(svc.assertFace(image)).rejects.toThrow(
      'Rasm saqlanmadi va terminalga yuborilmadi',
    );
    await svc.assertFace(image);
    expect(post).toHaveBeenCalledTimes(3);
  });
  it('rejects invalid image bytes without calling detection', async () => {
    const post = jest.spyOn(axios, 'post');
    await expect(
      new ProfileFaceValidationService().assertFace(Buffer.from('not image')),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });
  it('deduplicates simultaneous validation of the same image', async () => {
    const post = jest
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { faceCount: 1 } });
    const svc = new ProfileFaceValidationService();
    await Promise.all([
      svc.assertFace(image),
      svc.assertFace(image),
      svc.assertFace(image),
    ]);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

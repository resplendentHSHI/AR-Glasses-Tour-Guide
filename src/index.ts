import { AppServer, AppSession, ViewType, AuthenticatedRequest, PhotoData } from '@mentra/sdk';
import { Request, Response } from 'express';
import * as ejs from 'ejs';
import * as path from 'path';

/**
 * Interface representing a stored photo with metadata
 */
interface StoredPhoto {
  requestId: string;
  buffer: Buffer;
  timestamp: Date;
  userId: string;
  mimeType: string;
  filename: string;
  size: number;
}

const PACKAGE_NAME = process.env.PACKAGE_NAME ?? (() => { throw new Error('PACKAGE_NAME is not set in .env file'); })();
const MENTRAOS_API_KEY = process.env.MENTRAOS_API_KEY ?? (() => { throw new Error('MENTRAOS_API_KEY is not set in .env file'); })();
const PORT = parseInt(process.env.PORT || '3000');
// Add this environment variable at the top with your other constants
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY ?? (() => { throw new Error('GOOGLE_MAPS_API_KEY is not set in .env file'); })();

/**
 * MentraOS App combining photo capture, audio interaction, and webview
 */
class ExampleMentraOSApp extends AppServer {
  private photos: Map<string, StoredPhoto> = new Map();
  private latestPhotoTimestamp: Map<string, number> = new Map();
  private isStreamingPhotos: Map<string, boolean> = new Map();
  private nextPhotoTime: Map<string, number> = new Map();

  constructor() {
    super({
      packageName: PACKAGE_NAME,
      apiKey: MENTRAOS_API_KEY,
      port: PORT,
    });
    this.setupWebviewRoutes();
  }

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    this.logger.info(`Session started for user ${userId}`);

    // Set initial states for photos
    this.isStreamingPhotos.set(userId, false);
    this.nextPhotoTime.set(userId, Date.now());

    // Show welcome message and play TTS
    session.layouts.showTextWall("Example App is ready!");
    session.location.subscribeToStream({ accuracy: 'high' }, async (data) => {
      session.logger.info(`User is at: ${data.lat}, ${data.lng}`);
      
      // Get and log the address
      const address = await this.reverseGeocode(data.lat, data.lng);
      if (address) {
        session.logger.info(`User address: ${address}`);
      }
    });
    try {
      const result = await session.audio.speak("Welcome to Mentra OS! This is your audio assistant.");

      if (result.success) {
        session.logger.info("✅ Speech synthesis successful");
      } else {
        session.logger.error(`❌ TTS failed: ${result.error}`);
      }
    } catch (error) {
      session.logger.error(`Exception during TTS: ${error}`);
    }

    // Photo button press handling
    session.events.onButtonPress(async (button) => {
      this.logger.info(`Button pressed: ${button.buttonId}, type: ${button.pressType}`);
      if (button.pressType === 'long') {
        this.isStreamingPhotos.set(userId, !this.isStreamingPhotos.get(userId));
        this.logger.info(`Streaming photos for user ${userId} is now ${this.isStreamingPhotos.get(userId)}`);
        return;
      } else {
        session.logger.info("Button pressed, about to take photo", { durationMs: 4000 });
        try {
          const photo = await session.camera.requestPhoto();
          this.logger.info(`Photo taken for user ${userId}, timestamp: ${photo.timestamp}`);
          this.cachePhoto(photo, userId);
        } catch (error) {
          this.logger.error(`Error taking photo: ${error}`);
        }
      }
    });

    // Stream photos every 1s if enabled
    setInterval(async () => {
      if (this.isStreamingPhotos.get(userId) && Date.now() > (this.nextPhotoTime.get(userId) ?? 0)) {
        try {
          this.nextPhotoTime.set(userId, Date.now() + 30000);
          const photo = await session.camera.requestPhoto();
          this.nextPhotoTime.set(userId, Date.now());
          this.cachePhoto(photo, userId);
        } catch (error) {
          this.logger.error(`Error auto-taking photo: ${error}`);
        }
      }
    }, 1000);

    // Transcription events
    session.events.onTranscription(async (data) => {
      if (data.isFinal) {
        session.layouts.showTextWall("You said: " + data.text, {
          view: ViewType.MAIN,
          durationMs: 3000
        });
        try {
          const result = await session.audio.speak(data.text);
    
          if (result.success) {
            session.logger.info("✅ Speech synthesis successful");
          } else {
            session.logger.error(`❌ TTS failed: ${result.error}`);
          }
        } catch (error) {
          session.logger.error(`Exception during TTS: ${error}`);
        }
      }
    })

    // Battery level logs
    session.events.onGlassesBattery((data) => {
      console.log('Glasses battery:', data);
    });
  }

  protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
    this.isStreamingPhotos.set(userId, false);
    this.nextPhotoTime.delete(userId);
    this.logger.info(`Session stopped for user ${userId}, reason: ${reason}`);
  }

  private async cachePhoto(photo: PhotoData, userId: string) {
    const cachedPhoto: StoredPhoto = {
      requestId: photo.requestId,
      buffer: photo.buffer,
      timestamp: photo.timestamp,
      userId,
      mimeType: photo.mimeType,
      filename: photo.filename,
      size: photo.size
    };

    this.photos.set(userId, cachedPhoto);
    this.latestPhotoTimestamp.set(userId, cachedPhoto.timestamp.getTime());
    this.logger.info(`Photo cached for user ${userId}, timestamp: ${cachedPhoto.timestamp}`);
  }

  /**
   * Reverse geocode coordinates to get human-readable address
   */
  private async reverseGeocode(latitude: number, longitude: number): Promise<string | null> {
    try {
      const response = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${GOOGLE_MAPS_API_KEY}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch address from Google Maps');
      }

      const data = await response.json();

      if (data.results && data.results.length > 0) {
        return data.results[0].formatted_address;
      }

      return null;
    } catch (error) {
      this.logger.error(`Geocoding error: ${error}`);
      return null;
    }
  }

  private setupWebviewRoutes(): void {
    const app = this.getExpressApp();

    app.get('/api/latest-photo', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const photo = this.photos.get(userId);
      if (!photo) return res.status(404).json({ error: 'No photo available' });

      res.json({
        requestId: photo.requestId,
        timestamp: photo.timestamp.getTime(),
        hasPhoto: true
      });
    });

    app.get('/api/photo/:requestId', (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;
      const requestId = req.params.requestId;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });

      const photo = this.photos.get(userId);
      if (!photo || photo.requestId !== requestId) {
        return res.status(404).json({ error: 'Photo not found' });
      }

      res.set({
        'Content-Type': photo.mimeType,
        'Cache-Control': 'no-cache'
      });
      res.send(photo.buffer);
    });

    app.get('/webview', async (req: any, res: any) => {
      const userId = (req as AuthenticatedRequest).authUserId;

      if (!userId) {
        res.status(401).send(`
          <html>
            <head><title>Photo Viewer - Not Authenticated</title></head>
            <body style="font-family: Arial, sans-serif; text-align: center; padding: 50px;">
              <h1>Please open this page from the MentraOS app</h1>
            </body>
          </html>
        `);
        return;
      }

      const templatePath = path.join(process.cwd(), 'views', 'photo-viewer.ejs');
      const html = await ejs.renderFile(templatePath, {});
      res.send(html);
    });
  }
}

// Start the server
const app = new ExampleMentraOSApp();
app.start().catch(console.error);

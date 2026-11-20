package digital.thinkbox.dicompdf;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Iterator;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import org.dcm4che3.data.Attributes;
import org.dcm4che3.data.Tag;
import org.dcm4che3.data.UID;
import org.dcm4che3.data.VR;
import org.dcm4che3.io.DicomOutputStream;

/** Deterministic software phantoms only; never reads or transforms patient data. */
public final class ExpandedSyntheticFixtures {
    public static final int WIDTH = 64, HEIGHT = 48;
    public static final String STUDY_UID = "2.25.945092014509234551239000";
    private ExpandedSyntheticFixtures() {}

    public static void main(String[] args) throws Exception {
        Path root = Path.of(args.length == 0 ? "fixtures/expanded" : args[0]);
        writeAll(root);
        if(args.length>1) writeExternalCodecs(root,Path.of(args[1]));
        System.out.println("Wrote expanded synthetic image formats to " + root);
    }

    public static void writeAll(Path root) throws Exception {
        Files.createDirectories(root);
        write(root.resolve("ct-explicit-le-16.dcm"), UID.ExplicitVRLittleEndian, gray(UID.CTImageStorage,"CT",16,0,1,false));
        write(root.resolve("mr-explicit-le-signed16.dcm"), UID.ExplicitVRLittleEndian, gray(UID.MRImageStorage,"MR",16,1,2,false));
        write(root.resolve("ct-explicit-be-16.dcm"), UID.ExplicitVRBigEndian, gray(UID.CTImageStorage,"CT",16,0,3,true));
        write(root.resolve("mr-implicit-le-16.dcm"), UID.ImplicitVRLittleEndian, gray(UID.MRImageStorage,"MR",16,0,4,false));
        write(root.resolve("sc-signed8.dcm"), UID.ExplicitVRLittleEndian, gray(UID.SecondaryCaptureImageStorage,"OT",8,1,5,false));
        write(root.resolve("sc-rgb-interleaved.dcm"), UID.ExplicitVRLittleEndian, color(6,0,false));
        write(root.resolve("sc-rgb-planar.dcm"), UID.ExplicitVRLittleEndian, color(7,1,false));
        write(root.resolve("sc-ybr-full.dcm"), UID.ExplicitVRLittleEndian, color(8,0,true));
        Attributes multi = gray(UID.MultiFrameGrayscaleByteSecondaryCaptureImageStorage,"OT",8,0,9,false);
        multi.setInt(Tag.NumberOfFrames,VR.IS,2);
        byte[] first = multi.getBytes(Tag.PixelData), both = new byte[first.length*2];
        System.arraycopy(first,0,both,0,first.length);
        for (int i=0;i<first.length;i++) both[first.length+i]=(byte)(255-(first[i]&255));
        multi.setBytes(Tag.PixelData,VR.OB,both);
        write(root.resolve("sc-multiframe-gray8.dcm"),UID.ExplicitVRLittleEndian,multi);
        write(root.resolve("ct-deflated-16.dcm"),UID.DeflatedExplicitVRLittleEndian,gray(UID.CTImageStorage,"CT",16,0,10,false));
        Attributes jpegColor=color(11,0,false); jpegColor.setString(Tag.PhotometricInterpretation,VR.CS,"YBR_FULL_422");
        encapsulate(jpegColor,jpeg(colorImage()),UID.JPEGBaseline8Bit,root.resolve("sc-jpeg-baseline-rgb.dcm"));
        Attributes jpegGray=gray(UID.SecondaryCaptureImageStorage,"OT",8,0,12,false);
        encapsulate(jpegGray,jpeg(grayImage8()),UID.JPEGBaseline8Bit,root.resolve("sc-jpeg-baseline-gray8.dcm"));
        Attributes rle=gray(UID.SecondaryCaptureImageStorage,"OT",8,0,13,false);
        encapsulate(rle,rle8(rle.getBytes(Tag.PixelData)),UID.RLELossless,root.resolve("sc-rle-gray8.dcm"));
        write(root.resolve("sc-native-gray8.dcm"),UID.ExplicitVRLittleEndian,gray(UID.SecondaryCaptureImageStorage,"OT",8,0,19,false));
        encapsulate(gray(UID.SecondaryCaptureImageStorage,"OT",8,0,22,false),jpegLosslessConstant(8,100),UID.JPEGLosslessSV1,root.resolve("sc-jpeg-lossless-sv1-gray8.dcm"));
        encapsulate(gray(UID.SecondaryCaptureImageStorage,"OT",8,0,23,false),jpegLosslessConstant(8,100),UID.JPEGLossless,root.resolve("sc-jpeg-lossless14-gray8.dcm"));
        encapsulate(gray(UID.SecondaryCaptureImageStorage,"OT",16,0,24,false),jpegLosslessConstant(12,1000),UID.JPEGLosslessSV1,root.resolve("sc-jpeg-lossless-sv1-gray12.dcm"));
        write(root.resolve("sc-single-bit.dcm"),UID.ExplicitVRLittleEndian,singleBit());
        write(root.resolve("sc-palette-color.dcm"),UID.ExplicitVRLittleEndian,palette());
        write(root.resolve("sc-ybr-full-422.dcm"),UID.ExplicitVRLittleEndian,ybr422());
        write(root.resolve("mr-enhanced-functional-groups.dcm"),UID.ExplicitVRLittleEndian,enhancedMr());
    }

    public static void writeExternalCodecs(Path root,Path codestreams)throws IOException {
        Files.createDirectories(root);
        encapsulate(gray(UID.CTImageStorage,"CT",16,0,14,false),Files.readAllBytes(codestreams.resolve("gray16.j2k")),UID.JPEG2000Lossless,root.resolve("ct-jpeg2000-lossless16.dcm"));
        encapsulate(gray(UID.SecondaryCaptureImageStorage,"OT",8,0,18,false),Files.readAllBytes(codestreams.resolve("gray8.jls")),UID.JPEGLSLossless,root.resolve("sc-jpegls-lossless-gray8.dcm"));
        encapsulate(gray(UID.SecondaryCaptureImageStorage,"OT",16,0,20,false),Files.readAllBytes(codestreams.resolve("gray16.jls")),UID.JPEGLSLossless,root.resolve("sc-jpegls-lossless-gray16.dcm"));
        encapsulate(gray(UID.SecondaryCaptureImageStorage,"OT",8,0,21,false),Files.readAllBytes(codestreams.resolve("gray8-near.jls")),UID.JPEGLSNearLossless,root.resolve("sc-jpegls-near-lossless-gray8.dcm"));
    }

    private static Attributes base(String sopClass,String modality,int instance,boolean bigEndian) {
        Attributes a=new Attributes(bigEndian);
        a.setString(Tag.SOPClassUID,VR.UI,sopClass); a.setString(Tag.SOPInstanceUID,VR.UI,STUDY_UID+"."+instance);
        a.setString(Tag.StudyInstanceUID,VR.UI,STUDY_UID); a.setString(Tag.SeriesInstanceUID,VR.UI,STUDY_UID+".1");
        a.setString(Tag.PatientName,VR.PN,"Synthetic^ImageFormats"); a.setString(Tag.PatientID,VR.LO,"SYNTHETIC-NOT-A-PATIENT");
        a.setString(Tag.StudyDate,VR.DA,"20260101"); a.setString(Tag.Modality,VR.CS,modality);
        a.setString(Tag.StudyDescription,VR.LO,"Mathematical image codec fixtures; no patient data");
        a.setString(Tag.ImageType,VR.CS,"DERIVED","SECONDARY"); a.setInt(Tag.InstanceNumber,VR.IS,instance);
        a.setInt(Tag.Rows,VR.US,HEIGHT); a.setInt(Tag.Columns,VR.US,WIDTH);
        return a;
    }
    private static Attributes gray(String sopClass,String modality,int allocated,int signed,int instance,boolean bigEndian) {
        Attributes a=base(sopClass,modality,instance,bigEndian);
        a.setInt(Tag.SamplesPerPixel,VR.US,1); a.setString(Tag.PhotometricInterpretation,VR.CS,"MONOCHROME2");
        a.setInt(Tag.BitsAllocated,VR.US,allocated); int stored=allocated==8?8:12;
        a.setInt(Tag.BitsStored,VR.US,stored); a.setInt(Tag.HighBit,VR.US,stored-1); a.setInt(Tag.PixelRepresentation,VR.US,signed);
        a.setString(Tag.WindowCenter,VR.DS,signed==1?"0":allocated==8?"128":"2048");
        a.setString(Tag.WindowWidth,VR.DS,allocated==8?"256":"4096");
        ByteBuffer pixels=ByteBuffer.allocate(WIDTH*HEIGHT*allocated/8).order(bigEndian?ByteOrder.BIG_ENDIAN:ByteOrder.LITTLE_ENDIAN);
        for(int y=0;y<HEIGHT;y++) for(int x=0;x<WIDTH;x++) {
            int value=allocated==8?gray8(x,y):gray16(x,y);
            if(signed==1) value-=allocated==8?128:1024;
            if(allocated==8)pixels.put((byte)value);else pixels.putShort((short)value);
        }
        a.setBytes(Tag.PixelData,allocated==8?VR.OB:VR.OW,pixels.array());
        return a;
    }
    private static Attributes color(int instance,int planar,boolean ybr) {
        Attributes a=base(UID.SecondaryCaptureImageStorage,"OT",instance,false);
        a.setInt(Tag.SamplesPerPixel,VR.US,3);a.setString(Tag.PhotometricInterpretation,VR.CS,ybr?"YBR_FULL":"RGB");
        a.setInt(Tag.BitsAllocated,VR.US,8);a.setInt(Tag.BitsStored,VR.US,8);a.setInt(Tag.HighBit,VR.US,7);
        a.setInt(Tag.PixelRepresentation,VR.US,0);a.setInt(Tag.PlanarConfiguration,VR.US,planar);
        byte[] pixels=new byte[WIDTH*HEIGHT*3];
        for(int y=0;y<HEIGHT;y++)for(int x=0;x<WIDTH;x++) {
            int[] sample=colorSample(x);
            if(ybr)sample=x<WIDTH/3?new int[]{76,85,255}:x<WIDTH*2/3?new int[]{150,44,21}:new int[]{29,255,107};
            for(int c=0;c<3;c++) pixels[planar==0?(y*WIDTH+x)*3+c:c*WIDTH*HEIGHT+y*WIDTH+x]=(byte)sample[c];
        }
        a.setBytes(Tag.PixelData,VR.OB,pixels);return a;
    }
    private static Attributes enhancedMr() throws IOException {
        Attributes a=gray(UID.EnhancedMRImageStorage,"MR",16,0,25,false);
        byte[] first=a.getBytes(Tag.PixelData),frames=new byte[first.length*2];
        System.arraycopy(first,0,frames,0,first.length);System.arraycopy(first,0,frames,first.length,first.length);
        a.setBytes(Tag.PixelData,VR.OW,frames);a.setInt(Tag.NumberOfFrames,VR.IS,2);
        Attributes shared=new Attributes();
        a.newSequence(Tag.SharedFunctionalGroupsSequence,1).add(shared);
        var perFrame=a.newSequence(Tag.PerFrameFunctionalGroupsSequence,2);
        for(int frame=0;frame<2;frame++){
            Attributes item=new Attributes(),voi=new Attributes();voi.setString(Tag.WindowCenter,VR.DS,frame==0?"1024":"1000");voi.setString(Tag.WindowWidth,VR.DS,frame==0?"2048":"2000");item.newSequence(Tag.FrameVOILUTSequence,1).add(voi);
            Attributes transform=new Attributes();transform.setString(Tag.RescaleSlope,VR.DS,frame==0?"1":"2");transform.setString(Tag.RescaleIntercept,VR.DS,frame==0?"0":"-1000");item.newSequence(Tag.PixelValueTransformationSequence,1).add(transform);
            perFrame.add(item);
        }
        return a;
    }
    private static Attributes singleBit() {
        Attributes a=gray(UID.MultiFrameSingleBitSecondaryCaptureImageStorage,"OT",8,0,15,false);
        a.setInt(Tag.BitsAllocated,VR.US,1);a.setInt(Tag.BitsStored,VR.US,1);a.setInt(Tag.HighBit,VR.US,0);
        a.setString(Tag.WindowCenter,VR.DS,"0.5");a.setString(Tag.WindowWidth,VR.DS,"1");
        byte[] pixels=new byte[(WIDTH*HEIGHT+7)/8];
        for(int y=0;y<HEIGHT;y++)for(int x=0;x<WIDTH;x++)if(x>=WIDTH/2){int index=y*WIDTH+x;pixels[index/8]|=(byte)(1<<(index%8));}
        a.setBytes(Tag.PixelData,VR.OB,pixels);return a;
    }
    private static Attributes palette() {
        Attributes a=gray(UID.SecondaryCaptureImageStorage,"OT",8,0,16,false);
        a.remove(Tag.WindowCenter);a.remove(Tag.WindowWidth);a.setString(Tag.PhotometricInterpretation,VR.CS,"PALETTE COLOR");
        byte[] indices=new byte[WIDTH*HEIGHT];
        for(int y=0;y<HEIGHT;y++)for(int x=0;x<WIDTH;x++)indices[y*WIDTH+x]=(byte)(x<WIDTH/3?0:x<WIDTH*2/3?1:2);
        a.setBytes(Tag.PixelData,VR.OB,indices);
        int[] descriptors={Tag.RedPaletteColorLookupTableDescriptor,Tag.GreenPaletteColorLookupTableDescriptor,Tag.BluePaletteColorLookupTableDescriptor};
        int[] data={Tag.RedPaletteColorLookupTableData,Tag.GreenPaletteColorLookupTableData,Tag.BluePaletteColorLookupTableData};
        for(int c=0;c<3;c++){a.setInt(descriptors[c],VR.US,3,0,16);ByteBuffer values=ByteBuffer.allocate(6).order(ByteOrder.LITTLE_ENDIAN);for(int i=0;i<3;i++)values.putShort((short)(i==c?65535:0));a.setBytes(data[c],VR.OW,values.array());}
        return a;
    }
    private static Attributes ybr422() {
        Attributes a=color(17,0,true);a.setString(Tag.PhotometricInterpretation,VR.CS,"YBR_FULL_422");
        byte[] pixels=new byte[WIDTH*HEIGHT*2];int offset=0;
        for(int y=0;y<HEIGHT;y++)for(int x=0;x<WIDTH;x+=2){int[] c=x<WIDTH/3?new int[]{76,85,255}:x<WIDTH*2/3?new int[]{150,44,21}:new int[]{29,255,107};pixels[offset++]=(byte)c[0];pixels[offset++]=(byte)c[0];pixels[offset++]=(byte)c[1];pixels[offset++]=(byte)c[2];}
        a.setBytes(Tag.PixelData,VR.OB,pixels);return a;
    }
    static int gray8(int x,int y){return(x*3+y*5)&255;}
    static int gray16(int x,int y){return x*32+y*16;}
    static int[] colorSample(int x){return x<WIDTH/3?new int[]{220,32,16}:x<WIDTH*2/3?new int[]{16,210,32}:new int[]{16,32,220};}
    private static BufferedImage colorImage() {
        BufferedImage image=new BufferedImage(WIDTH,HEIGHT,BufferedImage.TYPE_INT_RGB);
        for(int y=0;y<HEIGHT;y++)for(int x=0;x<WIDTH;x++){int[] c=colorSample(x);image.setRGB(x,y,(c[0]<<16)|(c[1]<<8)|c[2]);}
        return image;
    }
    private static BufferedImage grayImage8(){BufferedImage image=new BufferedImage(WIDTH,HEIGHT,BufferedImage.TYPE_BYTE_GRAY);for(int y=0;y<HEIGHT;y++)for(int x=0;x<WIDTH;x++)image.getRaster().setSample(x,y,0,gray8(x,y));return image;}
    private static byte[] jpeg(BufferedImage image)throws IOException {
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        Iterator<ImageWriter>writers=ImageIO.getImageWritersByFormatName("JPEG");if(!writers.hasNext())throw new IOException("No JPEG writer");ImageWriter writer=writers.next();
        try(var stream=new MemoryCacheImageOutputStream(output)){writer.setOutput(stream);ImageWriteParam param=writer.getDefaultWriteParam();param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);param.setCompressionQuality(.95f);writer.write(null,new IIOImage(image,null,null),param);stream.flush();}finally{writer.dispose();}
        return output.toByteArray();
    }
    /** Minimal SOF3 predictor-1 stream with constant mathematical samples; no third-party fixture data. */
    private static byte[] jpegLosslessConstant(int precision,int sample)throws IOException {
        ByteArrayOutputStream out=new ByteArrayOutputStream();
        out.write(new byte[]{(byte)0xff,(byte)0xd8});
        ByteArrayOutputStream table=new ByteArrayOutputStream();table.write(0);
        for(int length=1;length<=16;length++)table.write(length==4?precision+1:0);
        for(int category=0;category<=precision;category++)table.write(category);
        jpegSegment(out,0xc4,table.toByteArray());
        jpegSegment(out,0xc3,new byte[]{(byte)precision,(byte)(HEIGHT>>8),(byte)HEIGHT,(byte)(WIDTH>>8),(byte)WIDTH,1,1,0x11,0});
        jpegSegment(out,0xda,new byte[]{1,1,0,1,0,0});
        StringBuilder bits=new StringBuilder();int difference=sample-(1<<(precision-1));
        int category=32-Integer.numberOfLeadingZeros(Math.abs(difference));
        appendBits(bits,category,4);
        int amplitude=difference<0?(1<<category)-1+difference:difference;appendBits(bits,amplitude,category);
        for(int i=1;i<WIDTH*HEIGHT;i++)appendBits(bits,0,4);
        while(bits.length()%8!=0)bits.append('1');
        for(int i=0;i<bits.length();i+=8){int value=Integer.parseInt(bits.substring(i,i+8),2);out.write(value);if(value==255)out.write(0);}
        out.write(new byte[]{(byte)0xff,(byte)0xd9});return out.toByteArray();
    }
    private static void jpegSegment(ByteArrayOutputStream out,int marker,byte[] data)throws IOException {
        out.write(255);out.write(marker);out.write((data.length+2)>>8);out.write((data.length+2)&255);out.write(data);
    }
    private static void appendBits(StringBuilder target,int value,int count){for(int shift=count-1;shift>=0;shift--)target.append(((value>>shift)&1)==0?'0':'1');}
    private static byte[] rle8(byte[] pixels)throws IOException {
        ByteArrayOutputStream output=new ByteArrayOutputStream();
        output.write(ByteBuffer.allocate(64).order(ByteOrder.LITTLE_ENDIAN).putInt(1).putInt(64).array());
        for(int row=0;row<HEIGHT;row++)for(int x=0;x<WIDTH;x+=128){int count=Math.min(128,WIDTH-x);output.write(count-1);output.write(pixels,row*WIDTH+x,count);}
        return output.toByteArray();
    }
    private static void encapsulate(Attributes attrs,byte[] encoded,String syntax,Path file)throws IOException {
        attrs.remove(Tag.PixelData);var fragments=attrs.newFragments(Tag.PixelData,VR.OB,2);fragments.add(new byte[0]);fragments.add(encoded);
        write(file,syntax,attrs);
    }
    private static void write(Path file,String syntax,Attributes attrs)throws IOException {
        try(var out=new DicomOutputStream(file.toFile())){out.writeDataset(attrs.createFileMetaInformation(syntax),attrs);}
    }
}
